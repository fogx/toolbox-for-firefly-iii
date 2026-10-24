import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfigWithEnv(flag?: string) {
  vi.resetModules();

  if (flag === undefined) {
    delete process.env.FINTS_LOG_REDACTION;
  } else {
    process.env.FINTS_LOG_REDACTION = flag;
  }

  return import('./index.js');
}

describe('server config', () => {
  afterEach(() => {
    delete process.env.FINTS_LOG_REDACTION;
    vi.resetModules();
  });

  it('does not warn when FinTS log redaction is enabled by default', async () => {
    const { validateConfig } = await loadConfigWithEnv();

    expect(validateConfig().warnings).not.toContain(
      'FINTS_LOG_REDACTION is disabled. FinTS debug logs may contain raw bank payloads, account data, and transaction details.'
    );
  });

  it('warns when FinTS log redaction is explicitly disabled', async () => {
    const { validateConfig } = await loadConfigWithEnv('false');

    expect(validateConfig().warnings).toContain(
      'FINTS_LOG_REDACTION is disabled. FinTS debug logs may contain raw bank payloads, account data, and transaction details.'
    );
  });
});

describe('AI provider config', () => {
  const AI_ENV = [
    'AI_PROVIDER',
    'AI_MODEL',
    'AI_API_KEY_ENV',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_EFFORT',
    'TOOLBOX_CLAUDE_KEY',
    'OPENAI_API_KEY',
    'OLLAMA_API_URL',
  ];

  async function loadWith(env: Record<string, string>) {
    vi.resetModules();
    for (const key of AI_ENV) delete process.env[key];
    Object.assign(process.env, env);
    return import('./index.js');
  }

  afterEach(() => {
    for (const key of AI_ENV) delete process.env[key];
    vi.resetModules();
  });

  it('auto-detects Anthropic from ANTHROPIC_API_KEY with Haiku 5.5 at low effort', async () => {
    const { config, isAIConfigured } = await loadWith({ ANTHROPIC_API_KEY: 'test-key' });

    expect(config.ai).toEqual({
      provider: 'anthropic',
      apiUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      model: 'claude-haiku-5-5',
      effort: 'low',
    });
    expect(isAIConfigured()).toBe(true);
  });

  it('prefers Anthropic over OpenAI when both keys are set', async () => {
    const { config } = await loadWith({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' });

    expect(config.ai.provider).toBe('anthropic');
    expect(config.ai.apiKey).toBe('a');
  });

  it('reads base URL, model and effort overrides', async () => {
    const { config } = await loadWith({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
      ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_EFFORT: 'medium',
    });

    expect(config.ai.apiUrl).toBe('https://proxy.example/anthropic');
    expect(config.ai.model).toBe('claude-sonnet-5-5');
    expect(config.ai.effort).toBe('medium');
  });

  it('lets AI_MODEL override the provider default', async () => {
    const { config } = await loadWith({ ANTHROPIC_API_KEY: 'k', AI_MODEL: 'claude-opus-5-5' });

    expect(config.ai.model).toBe('claude-opus-5-5');
  });

  it('reads the key from the env var named by AI_API_KEY_ENV', async () => {
    const { config } = await loadWith({
      AI_PROVIDER: 'anthropic',
      AI_API_KEY_ENV: 'TOOLBOX_CLAUDE_KEY',
      TOOLBOX_CLAUDE_KEY: 'from-custom-var',
    });

    expect(config.ai.apiKey).toBe('from-custom-var');
  });

  it('treats Anthropic without a key as not configured', async () => {
    const { config, isAIConfigured } = await loadWith({ AI_PROVIDER: 'anthropic' });

    expect(config.ai.provider).toBe('anthropic');
    expect(isAIConfigured()).toBe(false);
  });

  it('falls back to low effort for an unknown ANTHROPIC_EFFORT', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { config } = await loadWith({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_EFFORT: 'turbo' });

    expect(config.ai.effort).toBe('low');
    warn.mockRestore();
  });

  it('keeps the OpenAI key for the openai provider', async () => {
    const { config } = await loadWith({ OPENAI_API_KEY: 'o' });

    expect(config.ai.provider).toBe('openai');
    expect(config.ai.apiKey).toBe('o');
  });
});
