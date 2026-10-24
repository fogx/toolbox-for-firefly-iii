/**
 * /api/review — fast-blast categorization endpoint.
 *   GET  /queue?limit=20             list uncategorized withdrawals w/ Paperless preview + suggestion
 *   POST /approve  {tx_id, tj_id, category_name}
 *   POST /skip     {tx_id}  → adds "review-skipped" tag
 */
import { Router, Request, Response } from 'express';
import { getFireflyApi } from '../clients/firefly.js';
import { getDoc, extractDocIdFromExternalUrl, type PaperlessDoc } from '../clients/paperless.js';
import { analyzeForCategory } from '../clients/ai.js';
import { isAIConfigured, isFireflyConfigured } from '../config/index.js';
import { asyncHandler, badRequest } from '../middleware/index.js';
import { createLogger } from '../utils/logger.js';
import { PiiScrubError } from '../utils/piiScrubber.js';
import { parseSenderCategories } from '../utils/senderCategories.js';

const logger = createLogger('Review');
const router = Router();

router.use((_req, _res, next) => {
  if (!isFireflyConfigured()) throw badRequest('Firefly III is not configured.');
  next();
});

// Deterministic fast path before any AI call; see utils/senderCategories.ts.
const SENDER_CATEGORY = parseSenderCategories(process.env.REVIEW_SENDER_CATEGORIES);

function suggestCategory(needles: string[]): string | null {
  const hay = needles
    .filter(Boolean)
    .map((s) => s.toLowerCase())
    .join(' | ');
  for (const [k, v] of SENDER_CATEGORY) {
    if (hay.includes(k)) return v;
  }
  return null;
}

/**
 * AI suggestion from the bank line plus Paperless invoice content. Goes through
 * analyzeForCategory, which scrubs PII first and throws (sending nothing) when
 * the scrubber is unavailable.
 */
async function suggestViaAI(
  item: {
    description: string;
    destination_name: string;
    amount: string;
    paperless: PaperlessDoc | null;
  },
  categories: string[]
): Promise<string | null> {
  if (!isAIConfigured() || !categories.length) return null;

  const text = [
    `Bank description: ${item.description}`,
    `Merchant: ${item.destination_name}`,
    item.paperless ? `Invoice from: ${item.paperless.correspondent_name ?? ''}` : '',
    item.paperless ? `Invoice title: ${item.paperless.title}` : '',
    item.paperless ? `Invoice content:\n${item.paperless.content_preview}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await analyzeForCategory(text, item.amount, 'withdrawal', categories);
    return categories.find((c) => c.toLowerCase() === result.categoryName.toLowerCase()) ?? null;
  } catch (e) {
    if (e instanceof PiiScrubError) {
      logger.warn('AI suggestion skipped: PII scrubber unavailable');
    } else {
      logger.warn(`AI suggest failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
}

interface QueueItem {
  tx_id: number;
  tj_id: number;
  date: string;
  amount: string;
  currency: string;
  description: string;
  source_name: string;
  destination_name: string;
  tags: string[];
  external_url: string | null;
  paperless: PaperlessDoc | null;
  suggested_category: string | null;
  suggestion_source: 'paperless' | 'description' | 'ai' | null;
}

router.get(
  '/queue',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 30), 100);
    const ff = getFireflyApi();

    // Fetch withdrawals for the last N days, then filter uncategorized client-side.
    // Firefly's search doesn't natively filter category=null; safest is to page + filter.
    const days = Math.min(Number(req.query.days ?? 90), 365);
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    logger.debug(`review/queue: fetching withdrawals ${iso(start)}..${iso(end)}`);
    const txns = await ff.getAllTransactions(iso(start), iso(end), 'withdrawal');

    const flat: QueueItem[] = [];
    for (const t of txns) {
      const attrs = t.attributes;
      for (const sub of attrs.transactions || []) {
        if (sub.category_id || (sub.category_name && sub.category_name.length > 0)) continue;
        if ((sub.tags || []).includes('review-skipped')) continue;
        flat.push({
          tx_id: Number(t.id),
          tj_id: Number(sub.transaction_journal_id),
          date: (sub.date || '').slice(0, 10),
          amount: sub.amount,
          currency: sub.currency_code || 'EUR',
          description: sub.description || '',
          source_name: sub.source_name || '',
          destination_name: sub.destination_name || '',
          tags: sub.tags || [],
          external_url: sub.external_url || null,
          paperless: null,
          suggested_category: null,
          suggestion_source: null,
        });
        if (flat.length >= limit * 3) break;
      }
      if (flat.length >= limit * 3) break;
    }

    // Enrich (up to `limit`) with Paperless doc + suggestion. Sort so high-confidence first.
    const enrich = flat.slice(0, limit);

    // Fetch category list once, reused for AI prompts.
    let categories: string[] = [];
    try {
      const cats = await ff.getAllCategories();
      categories = cats.map((c) => c.attributes.name);
    } catch (e) {
      logger.warn(`categories fetch failed: ${(e as Error).message}`);
    }

    await Promise.all(
      enrich.map(async (it) => {
        const docId = extractDocIdFromExternalUrl(it.external_url);
        if (docId) {
          try {
            it.paperless = await getDoc(docId);
          } catch (e) {
            logger.warn(`paperless fetch ${docId}: ${(e as Error).message}`);
          }
        }
        // Fast path: SENDER_CATEGORY substring match (deterministic, no LLM).
        const needles = [
          it.paperless?.correspondent_name || '',
          it.paperless?.title || '',
          it.destination_name,
          it.description,
        ];
        const fast = suggestCategory(needles);
        if (fast) {
          it.suggested_category = fast;
          it.suggestion_source = it.paperless ? 'paperless' : 'description';
          return;
        }
        // AI fallback: only when we have Paperless context (real signal to work with).
        if (it.paperless && categories.length) {
          const ai = await suggestViaAI(
            {
              description: it.description,
              destination_name: it.destination_name,
              amount: it.amount,
              paperless: it.paperless,
            },
            categories
          );
          if (ai) {
            it.suggested_category = ai;
            it.suggestion_source = 'ai';
          }
        }
      })
    );
    // High-confidence (paperless-mapped) first, then AI, then description-only, then unmapped.
    enrich.sort((a, b) => {
      const rank = (x: QueueItem) =>
        x.suggestion_source === 'paperless'
          ? 3
          : x.suggestion_source === 'ai'
            ? 2
            : x.suggested_category
              ? 1
              : 0;
      return rank(b) - rank(a);
    });

    res.json({
      success: true,
      data: {
        items: enrich,
        total_uncategorized_scanned: flat.length,
        window_days: days,
      },
    });
  })
);

router.post(
  '/approve',
  asyncHandler(async (req: Request, res: Response) => {
    const { tx_id, tj_id, category_name } = req.body as {
      tx_id: number;
      tj_id: number;
      category_name: string;
    };
    if (!tx_id || !tj_id || !category_name)
      throw badRequest('tx_id, tj_id, category_name required');
    const ff = getFireflyApi();
    await ff.updateTransaction(String(tx_id), String(tj_id), { category_name });
    res.json({ success: true });
  })
);

// Stream a Paperless doc PDF through our backend (uses server token, avoids
// requiring the user's browser to be logged into paperless.fogx.dev and
// avoids X-Frame-Options blocks on cross-origin iframes).
router.get(
  '/doc/:id/preview',
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!id) throw badRequest('bad id');
    const baseUrl = (process.env.PAPERLESS_URL || '').replace(/\/+$/, '');
    const token = process.env.PAPERLESS_TOKEN || '';
    if (!baseUrl || !token) throw badRequest('Paperless not configured');
    const r = await fetch(`${baseUrl}/api/documents/${id}/preview/`, {
      headers: { Authorization: `Token ${token}` },
    });
    if (!r.ok) {
      res.status(r.status).json({ success: false, error: `Paperless preview HTTP ${r.status}` });
      return;
    }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=60');
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  })
);

router.get(
  '/categories',
  asyncHandler(async (_req: Request, res: Response) => {
    const ff = getFireflyApi();
    const cats = await ff.getAllCategories();
    res.json({
      success: true,
      data: cats.map((c) => ({ id: c.id, name: c.attributes.name })),
    });
  })
);

router.post(
  '/skip',
  asyncHandler(async (req: Request, res: Response) => {
    const { tx_id } = req.body as { tx_id: number };
    if (!tx_id) throw badRequest('tx_id required');
    const ff = getFireflyApi();
    await ff.addTagsToTransaction(String(tx_id), ['review-skipped']);
    res.json({ success: true });
  })
);

export default router;
