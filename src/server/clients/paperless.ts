/**
 * Minimal Paperless-ngx client.
 * Uses PAPERLESS_URL + PAPERLESS_TOKEN from env. Fetches a doc by ID.
 * Also parses a doc ID out of a Firefly external_url like:
 *   https://paperless.fogx.dev/documents/1783/
 */
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Paperless');

export interface PaperlessDoc {
  id: number;
  title: string;
  correspondent_name: string | null;
  content_preview: string;
  url: string;
  invoice_date: string | null;
  amount_eur: string | null;
}

export function extractDocIdFromExternalUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/documents\/(\d+)\/?/);
  return m ? Number(m[1]) : null;
}

const AMT_FIELD = Number(process.env.PAPERLESS_AMT_FIELD_ID ?? 1);
const DATE_FIELD = Number(process.env.PAPERLESS_DATE_FIELD_ID ?? 2);

function baseUrl(): string {
  return (process.env.PAPERLESS_URL || '').replace(/\/+$/, '');
}
function browserUrl(): string {
  return (process.env.PAPERLESS_PUBLIC_URL || process.env.PAPERLESS_URL || '').replace(/\/+$/, '');
}
function token(): string {
  return process.env.PAPERLESS_TOKEN || '';
}

let correspondents: Map<number, string> | null = null;

async function loadCorrespondents(): Promise<Map<number, string>> {
  if (correspondents) return correspondents;
  const m = new Map<number, string>();
  let url: string | null = `${baseUrl()}/api/correspondents/?page_size=200`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Token ${token()}` } });
    if (!r.ok) throw new Error(`Paperless correspondents: HTTP ${r.status}`);
    const j = (await r.json()) as {
      results: Array<{ id: number; name: string }>;
      next: string | null;
    };
    for (const c of j.results) m.set(c.id, c.name);
    // Follow pagination on the configured host only, so the token never goes
    // to whatever host Paperless puts into `next`.
    url = j.next ? `${baseUrl()}${new URL(j.next).pathname}${new URL(j.next).search}` : null;
  }
  correspondents = m;
  return m;
}

export async function getDoc(id: number): Promise<PaperlessDoc | null> {
  if (!baseUrl() || !token()) return null;
  const r = await fetch(`${baseUrl()}/api/documents/${id}/`, {
    headers: { Authorization: `Token ${token()}` },
  });
  if (!r.ok) {
    logger.warn(`Paperless doc ${id}: HTTP ${r.status}`);
    return null;
  }
  const d = (await r.json()) as {
    id: number;
    title: string;
    content: string | null;
    correspondent: number | null;
    custom_fields: Array<{ field: number; value: string | null }>;
  };
  const corrMap = await loadCorrespondents();
  const cf: Record<number, string | null> = {};
  for (const f of d.custom_fields || []) cf[f.field] = f.value;
  const content = (d.content || '').trim();
  const preview = content.split('\n').slice(0, 6).join('\n').slice(0, 500);
  return {
    id: d.id,
    title: d.title || '',
    correspondent_name: d.correspondent ? corrMap.get(d.correspondent) || null : null,
    content_preview: preview,
    url: `${browserUrl()}/documents/${d.id}/`,
    invoice_date: cf[DATE_FIELD] || null,
    amount_eur: cf[AMT_FIELD] || null,
  };
}
