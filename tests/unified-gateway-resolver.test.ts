import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/main/config/config-store';

const mocks = vi.hoisted(() => ({
  importLocalAuthToken: vi.fn(),
}));

vi.mock('../src/main/auth/local-auth', () => ({
  importLocalAuthToken: mocks.importLocalAuthToken,
}));

import { resolveUnifiedGatewayProfile } from '../src/main/claude/unified-gateway-resolver';

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    customProtocol: 'openai',
    model: 'gpt-5.3-codex',
    openaiMode: 'responses',
    activeProfileKey: 'openai',
    profiles: {},
    activeConfigSetId: 'default',
    configSets: [],
    claudeCodePath: '',
    defaultWorkdir: '',
    globalSkillsPath: '',
    enableDevLogs: true,
    sandboxEnabled: false,
    enableThinking: false,
    isConfigured: true,
    ...overrides,
  };
}

describe('resolveUnifiedGatewayProfile', () => {
  beforeEach(() => {
    mocks.importLocalAuthToken.mockReset();
    mocks.importLocalAuthToken.mockReturnValue(null);
  });

  it('keeps openrouter on openai-compatible upstream with normalized /api/v1', () => {
    const decision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'openrouter',
        apiKey: 'sk-or-v1-abc',
        baseUrl: 'https://openrouter.ai',
        customProtocol: 'anthropic',
      })
    );

    expect(decision.ok).toBe(true);
    expect(decision.profile).toMatchObject({
      upstreamKind: 'openai',
      upstreamBaseUrl: 'https://openrouter.ai/api/v1',
      upstreamApiKey: 'sk-or-v1-abc',
      model: 'openai/gpt-5.3-codex',
      requiresProxy: true,
    });
  });

  it('preserves google model ids for openrouter upstreams', () => {
    const decision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'openrouter',
        apiKey: 'sk-or-v1-abc',
        baseUrl: 'https://openrouter.ai/api',
        customProtocol: 'anthropic',
        model: 'google/gemini-3-flash-preview',
      })
    );

    expect(decision.ok).toBe(true);
    expect(decision.profile).toMatchObject({
      upstreamKind: 'openai',
      model: 'google/gemini-3-flash-preview',
    });
  });

  it('normalizes google model aliases to litellm-compatible gemini/ prefix', () => {
    const decision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.duckcoding.ai/v1',
        model: 'google/gemini-3-flash-preview',
      })
    );

    expect(decision.ok).toBe(true);
    expect(decision.profile).toMatchObject({
      upstreamKind: 'openai',
      model: 'gemini/gemini-3-flash-preview',
    });
  });

  it('does not drift openrouter to local codex oauth when key is missing', () => {
    mocks.importLocalAuthToken.mockReturnValue({
      provider: 'codex',
      token: 'oauth-local-token',
      path: '/tmp/codex-auth.json',
      account: 'acct_123456',
    });
    const decision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'openrouter',
        apiKey: '',
        baseUrl: 'https://openrouter.ai/api',
      })
    );

    expect(decision).toEqual({
      ok: false,
      reason: 'missing_key',
    });
  });

  it('uses local codex oauth fallback only for native openai provider', () => {
    mocks.importLocalAuthToken.mockReturnValue({
      provider: 'codex',
      token: 'oauth-local-token',
      path: '/tmp/codex-auth.json',
      account: 'acct_123456',
    });

    const openaiDecision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
      })
    );
    expect(openaiDecision.ok).toBe(true);
    expect(openaiDecision.profile).toMatchObject({
      upstreamKind: 'openai',
      upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamApiKey: 'oauth-local-token',
    });

    const customDecision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: '',
        baseUrl: 'https://api.duckcoding.ai/v1',
      })
    );
    expect(customDecision).toEqual({
      ok: false,
      reason: 'missing_key',
    });
  });

  it('allows empty key for custom/openai loopback gateways via placeholder', () => {
    const decision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8082',
      })
    );

    expect(decision.ok).toBe(true);
    expect(decision.profile).toMatchObject({
      upstreamKind: 'openai',
      upstreamBaseUrl: 'http://127.0.0.1:8082',
      upstreamApiKey: 'sk-openai-local-proxy',
    });
  });

  it('allows empty key for custom/anthropic loopback gateways via placeholder', () => {
    const decision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'custom',
        customProtocol: 'anthropic',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:8082',
      })
    );

    expect(decision.ok).toBe(true);
    expect(decision.profile).toMatchObject({
      upstreamKind: 'anthropic',
      upstreamBaseUrl: 'http://127.0.0.1:8082',
      upstreamApiKey: 'sk-ant-local-proxy',
    });
  });

  it('returns missing_base_url for custom providers without baseUrl', () => {
    const decision = resolveUnifiedGatewayProfile(
      createConfig({
        provider: 'custom',
        customProtocol: 'anthropic',
        apiKey: 'sk-test',
        baseUrl: '',
      })
    );
    expect(decision).toEqual({
      ok: false,
      reason: 'missing_base_url',
    });
  });
});
