/**
 * PII Scrubber
 *
 * Sanitises transaction descriptions before they are sent to an external AI provider.
 *
 * Two backends, selected via `SCRUB_BACKEND` env var:
 *
 *   - `presidio_http` (default): POST to a Presidio sidecar (PRESIDIO_URL,
 *     default http://pii_scrubber:8000/scrub). Works on every CPU — required
 *     on Pi 4 / Cortex-A72 where onnxruntime SIGILLs.
 *
 *   - `gliner2_local`: original in-process GLiNER2 ONNX path. Two-stage
 *     pipeline (regex + GLiNER2 multi-PII NER). Requires onnxruntime-node
 *     and a CPU with ARMv8.2-A dotprod (or x86_64). Kept for future Pi
 *     upgrades / x86_64 deployments.
 *
 * Both backends return the same `ScrubResult` shape so callers (clients/ai.ts)
 * are backend-agnostic. NER/HTTP failures fall back to regex-only output —
 * we never block AI calls because the scrubber is down.
 */

import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from './logger.js';

const logger = createLogger('PIIScrubber');

// -----------------------------------------------------------------------------
// Backend selection
// -----------------------------------------------------------------------------

type Backend = 'presidio_http' | 'gliner2_local';

function resolveBackend(): Backend {
  const raw = (process.env.SCRUB_BACKEND ?? 'presidio_http').toLowerCase();
  if (raw === 'gliner2_local' || raw === 'presidio_http') return raw;
  logger.warn(`Unknown SCRUB_BACKEND=${raw}; defaulting to presidio_http.`);
  return 'presidio_http';
}

const BACKEND: Backend = resolveBackend();
const PRESIDIO_URL = process.env.PRESIDIO_URL ?? 'http://pii_scrubber:8000/scrub';

logger.info(`PII scrub backend = ${BACKEND}` +
  (BACKEND === 'presidio_http' ? ` (url=${PRESIDIO_URL})` : ''));

// -----------------------------------------------------------------------------
// Regex layer
// -----------------------------------------------------------------------------

interface RegexRule {
  /** Human-readable id, surfaced in counters. */
  id: string;
  /** Pattern. Must use the `g` flag - we iterate matches. */
  re: RegExp;
  /**
   * Replacement function. Receives the full match and capture groups.
   * Return the string to substitute for the match (use '' to drop entirely).
   */
  replace: (match: string, ...groups: string[]) => string;
}

const REGEX_RULES: RegexRule[] = [
  // IBAN: preserve country code only.
  // DE89370400440532013000 -> DE
  {
    id: 'iban',
    re: /\b([A-Z]{2})\d{2}[A-Z0-9]{12,30}\b/g,
    replace: (_m, cc) => cc,
  },
  // BIC with explicit label: drop entirely.
  // "BIC COBADEFFXXX" -> ""
  {
    id: 'bic_labeled',
    re: /\bBIC\s+[A-Z]{4}[A-Z]{2}[A-Z0-9]{2,5}\b/g,
    replace: () => '',
  },
  // Mandate reference: "MANDATSREF DE99ZZZ00000123456" -> ""
  {
    id: 'mandate_ref',
    re: /\bMANDATSREF\s+\S+/g,
    replace: () => '',
  },
  // Creditor ID, multiple spellings, case-insensitive.
  // "CREDID DE12ZZZ00000654321", "CRED.ID ...", "GLAEUBIGER-ID ..."
  {
    id: 'creditor_id',
    re: /\b(?:CREDID|CRED\.\s?ID|GLAEUBIGER[-\s]?ID)\s+\S+/gi,
    replace: () => '',
  },
  // Long bare digit runs (>= 10) - catches BLZ, merchant ids, residual IBAN
  // bodies that escaped the IBAN rule.
  {
    id: 'long_digits',
    re: /\b\d{10,}\b/g,
    replace: () => '',
  },
];

// -----------------------------------------------------------------------------
// NER layer
// -----------------------------------------------------------------------------

/**
 * Labels that we keep verbatim - they carry useful categorization signal and
 * are not sensitive in the German banking context the user actually faces.
 * (PERSON: shows up as merchant name in many descriptions; CITY: needed to
 * disambiguate chains; ORGANIZATION: the whole point.)
 */
const KEEP_LABELS = new Set<string>([
  'person',
  'person_name',
  'first_name',
  'last_name',
  'city',
  'organization',
  'org',
  'company',
  'company_name',
  'brand',
]);

/**
 * Full label set probed at each call. We pass all 47 to the NER call so it
 * tags everything it knows about; redaction decisions are policy-side in
 * `KEEP_LABELS` / `LABEL_PLACEHOLDER`.
 *
 * Subset relevant to GLiNER2-privacy-filter-PII-multi. Unknown labels are
 * harmless - the model simply produces no spans for them.
 */
const NER_LABELS: string[] = [
  // Keep
  'person',
  'city',
  'organization',
  // Redact - generic PII
  'address',
  'street_address',
  'email',
  'phone',
  'phone_number',
  'date_of_birth',
  'age',
  'gender',
  'nationality',
  'job_title',
  // Redact - government / financial ids
  'social_security_number',
  'passport_number',
  'driver_license',
  'tax_id',
  'national_id',
  'credit_card',
  'bank_account',
  'iban',
  'bic',
  // Redact - online identifiers
  'username',
  'password',
  'ip_address',
  'mac_address',
  'url',
  'api_key',
  // Redact - health
  'medical_condition',
  'medication',
  'medical_record_number',
  // Redact - misc
  'license_plate',
  'vehicle_id',
  'coordinate',
  'zip_code',
  'postal_code',
  'country',
];

/**
 * Map an NER label to its placeholder. Generic, uppercased, short.
 *  - email -> [EMAIL]
 *  - street_address -> [ADDR]
 *  - social_security_number -> [SSN]
 */
function labelToPlaceholder(label: string): string {
  const l = label.toLowerCase();
  if (l === 'street_address' || l === 'address') return '[ADDR]';
  if (l === 'phone' || l === 'phone_number') return '[PHONE]';
  if (l === 'social_security_number') return '[SSN]';
  if (l === 'credit_card') return '[CC]';
  if (l === 'date_of_birth') return '[DOB]';
  if (l === 'zip_code' || l === 'postal_code') return '[ZIP]';
  if (l === 'ip_address') return '[IP]';
  return `[${l.toUpperCase()}]`;
}

const NER_THRESHOLD = 0.5;

// -----------------------------------------------------------------------------
// Model loader (lazy, one-shot)
// -----------------------------------------------------------------------------

type NerModel = {
  extractEntities: (
    text: string,
    labels: string[],
    options?: { threshold?: number }
  ) => Promise<Array<{ text: string; label: string; start: number; end: number; score: number }>>;
};

let modelPromise: Promise<NerModel | null> | null = null;

/**
 * Resolve the on-disk model directory. We honour PII_MODEL_PATH for tests /
 * dev, otherwise fall back to the path baked into the Docker image.
 */
function resolveModelPath(): string {
  return process.env.PII_MODEL_PATH ?? '/app/models/gliner2-pii';
}

async function loadModel(): Promise<NerModel | null> {
  const modelPath = resolveModelPath();

  if (!fs.existsSync(modelPath)) {
    logger.warn(
      `GLiNER2-PII model directory not found at ${modelPath}. ` +
        `Falling back to regex-only scrubbing. Set PII_MODEL_PATH or bundle the model in the image.`
    );
    return null;
  }

  try {
    // Dynamic imports so that the server can start even if the optional ML
    // dependencies are missing (e.g. in unit tests).
    const [{ GLiNER2ONNXRuntime }, { AutoTokenizer }] = await Promise.all([
      import('@lmoe/gliner-onnx'),
      import('@huggingface/transformers'),
    ]);

    const t0 = Date.now();
    const tokenizer = await AutoTokenizer.from_pretrained(modelPath);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tokenizerFn = (text: string, opts?: any) => (tokenizer as any)(text, opts);

    const runtime = await GLiNER2ONNXRuntime.create(modelPath, tokenizerFn, {
      precision: 'fp32',
    });

    logger.info(
      `GLiNER2-PII model loaded from ${modelPath} in ${Date.now() - t0}ms ` +
        `(${NER_LABELS.length} labels, threshold ${NER_THRESHOLD})`
    );

    return runtime as unknown as NerModel;
  } catch (err) {
    logger.error(
      `Failed to load GLiNER2-PII model from ${modelPath}: ${err instanceof Error ? err.message : err}. ` +
        `Falling back to regex-only scrubbing.`
    );
    return null;
  }
}

function getModel(): Promise<NerModel | null> {
  if (!modelPromise) {
    modelPromise = loadModel();
  }
  return modelPromise;
}

/**
 * Preload the model at server boot. Optional - the first scrub call would
 * otherwise pay the load cost. Safe to call repeatedly.
 *
 * Only meaningful for the gliner2_local backend; presidio_http warms its own
 * spaCy model in the sidecar container.
 */
export async function warmupPiiScrubber(): Promise<void> {
  if (BACKEND !== 'gliner2_local') return;
  await getModel();
}

// -----------------------------------------------------------------------------
// Scrub
// -----------------------------------------------------------------------------

/**
 * Apply a list of replacement rules to `text`, returning the new text and a
 * count of substitutions actually performed.
 */
function applyRegex(text: string): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const rule of REGEX_RULES) {
    out = out.replace(rule.re, (match, ...groups) => {
      hits += 1;
      // groups includes (...captures, offset, fullString, namedGroups?).
      // We only forward capture groups to the replacer, which all our rules use.
      return rule.replace(match, ...(groups.slice(0, -2) as string[]));
    });
  }
  return { text: out, hits };
}

/**
 * Apply NER spans to `text`. Spans overlapping ranges already covered by a
 * higher-scoring span are dropped (standard greedy de-overlap). Labels in
 * `KEEP_LABELS` pass through unchanged.
 */
async function applyNer(
  text: string,
  model: NerModel
): Promise<{ text: string; hits: number }> {
  if (!text.trim()) return { text, hits: 0 };

  let entities;
  try {
    entities = await model.extractEntities(text, NER_LABELS, { threshold: NER_THRESHOLD });
  } catch (err) {
    logger.warn(`NER inference failed: ${err instanceof Error ? err.message : err}`);
    return { text, hits: 0 };
  }

  // Build replacement spans, skipping KEEP labels.
  const spans = entities
    .filter((e) => !KEEP_LABELS.has(e.label.toLowerCase()))
    .map((e) => ({ start: e.start, end: e.end, replacement: labelToPlaceholder(e.label), score: e.score }))
    .sort((a, b) => b.score - a.score);

  // Greedy de-overlap: keep highest-scoring spans, drop any that overlap an
  // already-kept span.
  const kept: typeof spans = [];
  for (const s of spans) {
    if (kept.some((k) => s.start < k.end && s.end > k.start)) continue;
    kept.push(s);
  }

  // Apply right-to-left so character offsets stay valid.
  kept.sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of kept) {
    out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  }

  return { text: out, hits: kept.length };
}

export interface ScrubResult {
  text: string;
  originalLen: number;
  redactedLen: number;
  regexHits: number;
  nerHits: number;
}

/**
 * Call the Presidio sidecar over HTTP. On any failure (network / non-2xx /
 * malformed JSON) we fall back to the local regex layer so AI calls keep
 * working — matches the original "never block" contract.
 */
async function scrubViaPresidio(input: string): Promise<ScrubResult> {
  const originalLen = input.length;
  try {
    const res = await fetch(PRESIDIO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: input, language: 'de' }),
      // Cap the wait so a hung sidecar can't stall every AI call.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`presidio sidecar ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      text: string;
      regex_hits: number;
      ner_hits: number;
      original_len: number;
      redacted_len: number;
    };
    return {
      text: json.text,
      originalLen: json.original_len,
      redactedLen: json.redacted_len,
      regexHits: json.regex_hits,
      nerHits: json.ner_hits,
    };
  } catch (err) {
    logger.warn(
      `Presidio sidecar call failed (${err instanceof Error ? err.message : err}); ` +
        `falling back to local regex-only scrub.`
    );
    const after = applyRegex(input);
    const cleaned = after.text.replace(/\s{2,}/g, ' ').trim();
    return {
      text: cleaned,
      originalLen,
      redactedLen: cleaned.length,
      regexHits: after.hits,
      nerHits: 0,
    };
  }
}

/** Original in-process GLiNER2 pipeline. Unchanged from pre-sidecar code. */
async function scrubViaGliner2Local(input: string): Promise<ScrubResult> {
  const originalLen = input.length;

  // 1) Regex layer first - cheaper and deterministic.
  const afterRegex = applyRegex(input);

  // 2) NER layer, if model is available.
  const model = await getModel();
  const afterNer = model
    ? await applyNer(afterRegex.text, model)
    : { text: afterRegex.text, hits: 0 };

  // Collapse double whitespace introduced by dropped tokens.
  const cleaned = afterNer.text.replace(/\s{2,}/g, ' ').trim();

  return {
    text: cleaned,
    originalLen,
    redactedLen: cleaned.length,
    regexHits: afterRegex.hits,
    nerHits: afterNer.hits,
  };
}

/**
 * Scrub PII from a transaction description. Always returns a value; never
 * throws (NER/HTTP failures fall back to regex-only output).
 *
 * The returned `text` is what should be forwarded to the AI provider. The
 * concrete backend is selected at module load via SCRUB_BACKEND.
 */
export async function scrubPii(input: string): Promise<ScrubResult> {
  const result =
    BACKEND === 'presidio_http'
      ? await scrubViaPresidio(input)
      : await scrubViaGliner2Local(input);

  logger.debug(
    `[PII scrubbed: backend=${BACKEND}, original_len=${result.originalLen}, ` +
      `redacted_len=${result.redactedLen}, regex_hits=${result.regexHits}, ` +
      `ner_hits=${result.nerHits}]`
  );

  return result;
}

// Re-exported for tests.
export const __test = {
  applyRegex,
  REGEX_RULES,
  KEEP_LABELS,
  labelToPlaceholder,
  NER_LABELS,
  resolveModelPath,
  // Allow tests to inject a fake model and reset the singleton.
  reset: (): void => {
    modelPromise = null;
  },
  injectModel: (m: NerModel | null): void => {
    modelPromise = Promise.resolve(m);
  },
};

// Quiet unused-marker for path import (kept for future use if we add bundled defaults).
void path;
