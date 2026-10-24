import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.fn();
const scrubMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function MockAnthropic() {
    return { messages: { create: createMock } };
  }),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../utils/piiScrubber.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/piiScrubber.js')>();
  return { ...actual, scrubPii: scrubMock };
});

const RAW = 'LASTSCHRIFT Max Mustermann Hauptstr. 1 Berlin REWE';
const SCRUBBED = 'LASTSCHRIFT [PERSON] [ADDR] REWE';

function claudeAnswer(answer: unknown, stopReason = 'end_turn') {
  return {
    stop_reason: stopReason,
    stop_details: null,
    content:
      answer === null
        ? []
        : [
            { type: 'thinking', thinking: '', signature: 'sig' },
            { type: 'text', text: JSON.stringify(answer) },
          ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

async function loadAi() {
  vi.resetModules();
  process.env.AI_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  return import('./ai.js');
}

describe('ai client (anthropic)', () => {
  beforeEach(() => {
    createMock.mockReset();
    scrubMock.mockReset();
    scrubMock.mockResolvedValue({
      text: SCRUBBED,
      originalLen: RAW.length,
      redactedLen: SCRUBBED.length,
      regexHits: 0,
      nerHits: 2,
    });
  });

  afterEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
  });

  describe('fail closed when the PII scrubber is down', () => {
    it('analyzeForCategory sends nothing', async () => {
      const { PiiScrubError } = await import('../utils/piiScrubber.js');
      scrubMock.mockRejectedValue(new PiiScrubError('PII scrubber unreachable'));
      const { analyzeForCategory } = await loadAi();

      await expect(
        analyzeForCategory(RAW, '12.50', 'withdrawal', ['groceries'])
      ).rejects.toBeInstanceOf(PiiScrubError);
      expect(createMock).not.toHaveBeenCalled();
    });

    it('analyzeForTags sends nothing', async () => {
      const { PiiScrubError } = await import('../utils/piiScrubber.js');
      scrubMock.mockRejectedValue(new PiiScrubError('PII scrubber returned HTTP 503'));
      const { analyzeForTags } = await loadAi();

      await expect(analyzeForTags(RAW, '12.50', 'withdrawal', [], ['food'])).rejects.toBeInstanceOf(
        PiiScrubError
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe('analyzeForCategory', () => {
    it('sends only the scrubbed text to Claude Haiku 5.5 with structured output', async () => {
      createMock.mockResolvedValue(
        claudeAnswer({ categoryName: 'groceries', confidence: 0.9, reasoning: 'Supermarket' })
      );
      const { analyzeForCategory } = await loadAi();

      const result = await analyzeForCategory(RAW, '12.5', 'withdrawal', ['groceries', 'rent']);

      expect(result).toEqual({
        categoryName: 'groceries',
        confidence: 0.9,
        reasoning: 'Supermarket',
      });
      expect(scrubMock).toHaveBeenCalledWith(RAW);
      const [params] = createMock.mock.calls[0] as [Record<string, unknown>];
      const sent = JSON.stringify(params);
      expect(sent).toContain(SCRUBBED);
      expect(sent).not.toContain('Mustermann');
      expect(sent).not.toContain('Hauptstr');
      expect(params.model).toBe('claude-haiku-5-5');
      expect(params).not.toHaveProperty('temperature');
      const outputConfig = params.output_config as { effort: string; format: unknown };
      expect(outputConfig.effort).toBe('low');
      expect(outputConfig.format).toBeDefined();
    });

    it('restricts the answer to the available categories plus Uncategorized', async () => {
      createMock.mockResolvedValue(
        claudeAnswer({ categoryName: 'rent', confidence: 0.5, reasoning: '' })
      );
      const { analyzeForCategory } = await loadAi();

      await analyzeForCategory(RAW, '1', 'withdrawal', ['groceries', 'rent']);

      const [params] = createMock.mock.calls[0] as [{ output_config: { format: unknown } }];
      expect(params.output_config.format).toEqual({
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            categoryName: { type: 'string', enum: ['groceries', 'rent', 'Uncategorized'] },
            confidence: { type: 'number' },
            reasoning: { type: 'string' },
          },
          required: ['categoryName', 'confidence', 'reasoning'],
          additionalProperties: false,
        },
      });
    });

    it('clamps confidence into 0..1', async () => {
      createMock.mockResolvedValue(
        claudeAnswer({ categoryName: 'rent', confidence: 7, reasoning: '' })
      );
      const { analyzeForCategory } = await loadAi();

      const result = await analyzeForCategory(RAW, '1', 'withdrawal', ['rent']);

      expect(result.confidence).toBe(1);
    });

    it('throws on a refusal', async () => {
      createMock.mockResolvedValue(claudeAnswer(null, 'refusal'));
      const { analyzeForCategory } = await loadAi();

      await expect(analyzeForCategory(RAW, '1', 'withdrawal', ['rent'])).rejects.toThrow(
        'AI declined the request'
      );
    });

    it('rejects an answer outside the category list', async () => {
      createMock.mockResolvedValue(
        claudeAnswer({ categoryName: 'casino', confidence: 0.9, reasoning: '' })
      );
      const { analyzeForCategory } = await loadAi();

      await expect(analyzeForCategory(RAW, '1', 'withdrawal', ['rent'])).rejects.toThrow(
        'did not match'
      );
    });

    it('throws when the answer was cut off', async () => {
      createMock.mockResolvedValue(claudeAnswer(null, 'max_tokens'));
      const { analyzeForCategory } = await loadAi();

      await expect(analyzeForCategory(RAW, '1', 'withdrawal', ['rent'])).rejects.toThrow(
        'max_tokens'
      );
    });
  });

  describe('analyzeForTags', () => {
    it('drops tags already on the transaction and caps at five', async () => {
      const suggestion = (tagName: string) => ({ tagName, confidence: 0.8, reasoning: '' });
      createMock.mockResolvedValue(
        claudeAnswer({
          suggestions: ['food', 'a', 'b', 'c', 'd', 'e', 'f'].map(suggestion),
        })
      );
      const { analyzeForTags } = await loadAi();

      const result = await analyzeForTags(
        RAW,
        '1',
        'withdrawal',
        ['food'],
        ['food', 'a', 'b', 'c', 'd', 'e', 'f']
      );

      expect(result.map((s) => s.tagName)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });
});
