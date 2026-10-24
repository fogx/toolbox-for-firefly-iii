import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiiScrubError, __test, scrubPii } from './piiScrubber.js';

vi.mock('./logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { applyRegex } = __test;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('piiScrubber', () => {
  describe('applyRegex', () => {
    it('keeps only the country code of an IBAN', () => {
      expect(applyRegex('SEPA DE89370400440532013000 Miete')).toEqual({
        text: 'SEPA DE Miete',
        hits: 1,
      });
    });

    it('drops a labelled BIC', () => {
      expect(applyRegex('Zahlung BIC COBADEFFXXX Ende').text).toBe('Zahlung  Ende');
    });

    it('drops mandate references and creditor ids in all spellings', () => {
      const input =
        'MANDATSREF M-123 CREDID DE12ZZZ00000654321 CRED. ID X1 glaeubiger-id Y2 Netflix';
      const out = applyRegex(input);
      expect(out.text.trim()).toBe('Netflix');
    });

    it('drops digit runs of ten or more but keeps shorter numbers', () => {
      expect(applyRegex('Kunde 12345678901 Filiale 1234').text).toBe('Kunde  Filiale 1234');
    });

    it('leaves text without identifiers unchanged', () => {
      expect(applyRegex('REWE Markt Berlin')).toEqual({ text: 'REWE Markt Berlin', hits: 0 });
    });
  });

  describe('scrubPii', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
      delete process.env.PRESIDIO_URL;
      delete process.env.PRESIDIO_TIMEOUT_MS;
      delete process.env.PII_SCRUB_LOG_TEXT;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('posts German text to the default sidecar URL', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ text: 'REWE [PERSON]', regex_hits: 0, ner_hits: 1 })
      );

      await scrubPii('REWE Max Mustermann');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(__test.DEFAULT_PRESIDIO_URL);
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        text: 'REWE Max Mustermann',
        language: 'de',
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('honours PRESIDIO_URL', async () => {
      process.env.PRESIDIO_URL = 'http://scrubber.test/scrub';
      fetchMock.mockResolvedValue(jsonResponse({ text: 'x', regex_hits: 0, ner_hits: 0 }));

      await scrubPii('x');

      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://scrubber.test/scrub');
    });

    it('returns the sidecar text with counters', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ text: 'Miete an [PERSON] [ADDR]', regex_hits: 2, ner_hits: 2 })
      );

      const input = 'Miete an Erika Muster, Hauptstr. 1 DE89370400440532013000';
      const result = await scrubPii(input);

      expect(result).toEqual({
        text: 'Miete an [PERSON] [ADDR]',
        originalLen: input.length,
        redactedLen: 24,
        regexHits: 2,
        nerHits: 2,
      });
    });

    it('runs the local regex layer over the sidecar output', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ text: 'Abbuchung DE89370400440532013000 Strom', regex_hits: 0, ner_hits: 0 })
      );

      const result = await scrubPii('Abbuchung DE89370400440532013000 Strom');

      expect(result.text).toBe('Abbuchung DE Strom');
      expect(result.regexHits).toBe(1);
    });

    it('does not call the sidecar for blank input', async () => {
      const result = await scrubPii('   ');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.text).toBe('');
    });

    it('fails closed when the sidecar is unreachable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(scrubPii('Max Mustermann, Hauptstr. 1')).rejects.toBeInstanceOf(PiiScrubError);
    });

    it('fails closed when the sidecar times out', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

      await expect(scrubPii('Max Mustermann')).rejects.toThrow(/unreachable/);
    });

    it('fails closed on a non-2xx answer', async () => {
      fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));

      await expect(scrubPii('Max Mustermann')).rejects.toThrow('PII scrubber returned HTTP 503');
    });

    it('fails closed on invalid JSON', async () => {
      fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

      await expect(scrubPii('Max Mustermann')).rejects.toThrow('invalid JSON');
    });

    it('fails closed when the body lacks the scrubbed text', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ regex_hits: 0, ner_hits: 0 }));

      await expect(scrubPii('Max Mustermann')).rejects.toThrow('unexpected response shape');
    });

    it('never puts the original text into the error', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      const error = await scrubPii('Max Mustermann').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PiiScrubError);
      expect(String((error as Error).message)).not.toContain('Mustermann');
    });
  });
});
