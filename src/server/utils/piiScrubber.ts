/**
 * PII Scrubber
 *
 * Sanitises transaction text before it is sent to an external AI provider.
 *
 * Pipeline:
 *   1. POST the text to the Presidio sidecar (PRESIDIO_URL, default
 *      http://pii_scrubber:8000/scrub). The sidecar runs NER (names,
 *      addresses, ...) plus its own regex layer.
 *   2. Run the local regex layer over the sidecar's output as a safety net
 *      for bank identifiers (IBAN, BIC, mandate / creditor ids, long digit runs).
 *
 * Fail closed: if the sidecar is unreachable, times out, answers non-2xx or
 * returns a malformed body, `scrubPii` throws `PiiScrubError`. Callers must not
 * send the text anywhere in that case. The local regex layer alone does not
 * catch names or addresses, so it is never used as a fallback.
 */

import { createLogger } from './logger.js';

const logger = createLogger('PIIScrubber');

const DEFAULT_PRESIDIO_URL = 'http://pii_scrubber:8000/scrub';
const DEFAULT_TIMEOUT_MS = 5_000;

/** Thrown when text cannot be scrubbed. The text must not leave the host. */
export class PiiScrubError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PiiScrubError';
  }
}

function presidioUrl(): string {
  return process.env.PRESIDIO_URL || DEFAULT_PRESIDIO_URL;
}

function presidioTimeoutMs(): number {
  const raw = Number(process.env.PRESIDIO_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

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

/**
 * Apply the regex rules to `text`, returning the new text and a count of
 * substitutions actually performed.
 */
function applyRegex(text: string): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const rule of REGEX_RULES) {
    out = out.replace(rule.re, (match, ...groups) => {
      hits += 1;
      // groups includes (...captures, offset, fullString). Forward only the
      // capture groups to the replacer.
      return rule.replace(match, ...(groups.slice(0, -2) as string[]));
    });
  }
  return { text: out, hits };
}

/** Collapse double whitespace introduced by dropped tokens. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s{2,}/g, ' ').trim();
}

// -----------------------------------------------------------------------------
// Presidio sidecar
// -----------------------------------------------------------------------------

interface PresidioResponse {
  text: string;
  regex_hits: number;
  ner_hits: number;
}

function isPresidioResponse(value: unknown): value is PresidioResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.text === 'string' && typeof v.regex_hits === 'number' && typeof v.ner_hits === 'number'
  );
}

async function callPresidio(input: string): Promise<PresidioResponse> {
  const url = presidioUrl();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: input, language: 'de' }),
      // Cap the wait so a hung sidecar can't stall every AI call.
      signal: AbortSignal.timeout(presidioTimeoutMs()),
    });
  } catch (err) {
    throw new PiiScrubError(
      `PII scrubber unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  if (!res.ok) {
    throw new PiiScrubError(`PII scrubber returned HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new PiiScrubError('PII scrubber returned invalid JSON', { cause: err });
  }

  if (!isPresidioResponse(body)) {
    throw new PiiScrubError('PII scrubber returned an unexpected response shape');
  }
  return body;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface ScrubResult {
  text: string;
  originalLen: number;
  redactedLen: number;
  regexHits: number;
  nerHits: number;
}

/**
 * Scrub PII from transaction text.
 *
 * @throws PiiScrubError when the sidecar can't scrub the text. The caller must
 *   then skip the AI call; never fall back to sending `input`.
 */
export async function scrubPii(input: string): Promise<ScrubResult> {
  const originalLen = input.length;

  if (!input.trim()) {
    return { text: '', originalLen, redactedLen: 0, regexHits: 0, nerHits: 0 };
  }

  let sidecar: PresidioResponse;
  try {
    sidecar = await callPresidio(input);
  } catch (err) {
    logger.error(
      `${err instanceof Error ? err.message : String(err)}; refusing to send unscrubbed text to the AI provider.`
    );
    throw err;
  }

  const local = applyRegex(sidecar.text);
  const text = collapseWhitespace(local.text);

  const result: ScrubResult = {
    text,
    originalLen,
    redactedLen: text.length,
    regexHits: sidecar.regex_hits + local.hits,
    nerHits: sidecar.ner_hits,
  };

  logger.debug(
    `[PII scrubbed: original_len=${result.originalLen}, redacted_len=${result.redactedLen}, ` +
      `regex_hits=${result.regexHits}, ner_hits=${result.nerHits}]`
  );
  if (process.env.PII_SCRUB_LOG_TEXT === 'true') {
    // Opt-in, for checking what leaves the host. Logs the scrubbed text only,
    // never the input.
    logger.info(`[PII scrubbed text] ${result.text}`);
  }

  return result;
}

// Re-exported for tests.
export const __test = {
  applyRegex,
  REGEX_RULES,
  DEFAULT_PRESIDIO_URL,
  DEFAULT_TIMEOUT_MS,
};
