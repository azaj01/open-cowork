import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildClaudeEnv, getClaudeEnvOverrides } from '../src/main/claude/claude-env';
import type { AppConfig } from '../src/main/config/config-store';

vi.mock('../src/main/auth/local-auth', () => ({
  importLocalAuthToken: vi.fn(() => ({
    provider: 'codex',
    token: 'oauth-local-token',
    path: '/tmp/codex-auth.json',
    account: 'acct_123456',
  })),
}));

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

afterEach(() => {
  resetEnv();
});

describe('buildClaudeEnv', () => {
  it('applies explicit overrides on top of sanitized shell env', () => {
    const shellEnv = { ANTHROPIC_API_KEY: 'old-key', PATH: '/bin' };
    const env = buildClaudeEnv(shellEnv, {
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: 'https://example.com',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('test-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.com');
    expect(env.PATH).toBe('/bin');
  });

  it('removes conflicting credential keys from shell env', () => {
    const shellEnv = {
      ANTHROPIC_API_KEY: 'old-key',
      OPENAI_API_KEY: 'old-openai',
      GEMINI_API_KEY: 'old-gemini',
      GEMINI_BASE_URL: 'https://gemini.example',
      PATH: '/bin',
    };
    const env = buildClaudeEnv(shellEnv);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GEMINI_BASE_URL).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });
});

describe('getClaudeEnvOverrides', () => {
  const baseConfig: AppConfig = {
    provider: 'anthropic',
    apiKey: 'sk-ant-test-key',
    baseUrl: 'https://api.anthropic.com',
    customProtocol: 'anthropic',
    model: 'claude-sonnet-4-5',
    openaiMode: 'responses',
    activeProfileKey: 'anthropic',
    activeConfigSetId: 'default',
    profiles: {
      anthropic: {
        apiKey: 'sk-ant-test-key',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        openaiMode: 'responses',
      },
      openrouter: {
        apiKey: '',
        baseUrl: 'https://openrouter.ai/api',
        model: 'anthropic/claude-sonnet-4.5',
        openaiMode: 'responses',
      },
      openai: {
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.2',
        openaiMode: 'responses',
      },
      'custom:anthropic': {
        apiKey: '',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        model: 'glm-4.7',
        openaiMode: 'responses',
      },
      'custom:openai': {
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.2',
        openaiMode: 'responses',
      },
    },
    configSets: [
      {
        id: 'default',
        name: '默认方案',
        isSystem: true,
        provider: 'anthropic',
        customProtocol: 'anthropic',
        activeProfileKey: 'anthropic',
        profiles: {
          anthropic: {
            apiKey: 'sk-ant-test-key',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-sonnet-4-5',
            openaiMode: 'responses',
          },
          openrouter: {
            apiKey: '',
            baseUrl: 'https://openrouter.ai/api',
            model: 'anthropic/claude-sonnet-4.5',
            openaiMode: 'responses',
          },
          openai: {
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-5.2',
            openaiMode: 'responses',
          },
          'custom:anthropic': {
            apiKey: '',
            baseUrl: 'https://open.bigmodel.cn/api/anthropic',
            model: 'glm-4.7',
            openaiMode: 'responses',
          },
          'custom:openai': {
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-5.2',
            openaiMode: 'responses',
          },
        },
        enableThinking: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    claudeCodePath: '',
    defaultWorkdir: '',
    enableDevLogs: true,
    sandboxEnabled: false,
    enableThinking: false,
    isConfigured: true,
  };

  it('maps anthropic provider to ANTHROPIC_API_KEY', () => {
    const env = getClaudeEnvOverrides(baseConfig);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('maps openrouter provider to ANTHROPIC_AUTH_TOKEN', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-test-key');
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('maps anthropic oauth token to ANTHROPIC_AUTH_TOKEN', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      apiKey: 'oauth-access-token',
    });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('oauth-access-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('maps custom openai protocol to OPENAI_API_KEY', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      provider: 'custom',
      customProtocol: 'openai',
      baseUrl: 'https://example.com/openai',
    });
    expect(env.OPENAI_API_KEY).toBe('sk-ant-test-key');
    expect(env.OPENAI_CODEX_OAUTH).toBe('0');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.com/openai');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-5');
  });

  it('does not mirror custom openai credentials to anthropic vars for official openai host', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      provider: 'custom',
      customProtocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.3-codex',
    });
    expect(env.OPENAI_API_KEY).toBe('sk-ant-test-key');
    expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
  });

  it('maps codex oauth token to codex backend when using openai provider', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      provider: 'openai',
      customProtocol: 'openai',
      apiKey: 'oauth-imported-token',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.3-codex',
    });
    expect(env.OPENAI_API_KEY).toBe('oauth-imported-token');
    expect(env.OPENAI_BASE_URL).toBe('https://chatgpt.com/backend-api/codex');
    expect(env.OPENAI_CODEX_OAUTH).toBe('1');
    expect(env.OPENAI_ACCOUNT_ID).toBe('acct_123456');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('normalizes /v1 when mirroring custom openai base url to anthropic vars', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      provider: 'custom',
      customProtocol: 'openai',
      baseUrl: 'https://api.duckcoding.ai/v1',
      model: 'gpt-5.3-codex',
    });
    expect(env.OPENAI_BASE_URL).toBe('https://api.duckcoding.ai/v1');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.duckcoding.ai');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.3-codex');
  });

  it('injects placeholder api key for local custom anthropic gateway when key is empty', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      provider: 'custom',
      customProtocol: 'anthropic',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8082',
      model: 'openai/gpt-4.1-mini',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-local-proxy');
    expect(env.CLAUDE_MODEL).toBe('openai/gpt-4.1-mini');
  });

  it('injects placeholder api key for ipv6 loopback custom anthropic gateway', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      provider: 'custom',
      customProtocol: 'anthropic',
      apiKey: '',
      baseUrl: 'http://[::1]:8082',
      model: 'openai/gpt-4.1-mini',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-local-proxy');
  });

  it('normalizes trailing /v1 for anthropic-compatible base urls', () => {
    const env = getClaudeEnvOverrides({
      ...baseConfig,
      provider: 'custom',
      customProtocol: 'anthropic',
      apiKey: 'sk-test',
      baseUrl: 'https://api.duckcoding.ai/v1',
      model: 'gpt-5.3-codex',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.duckcoding.ai');
  });
});
