import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  importLocalAuthToken: vi.fn(),
}));

vi.mock('../src/main/auth/local-auth', () => ({
  importLocalAuthToken: mocks.importLocalAuthToken,
}));

import {
  buildOpenAICodexHeaders,
  getUnifiedUnsupportedCustomOpenAIBaseUrl,
  isOfficialOpenAIBaseUrl,
  isLoopbackBaseUrl,
  isLikelyOAuthAccessToken,
  normalizeAnthropicBaseUrl,
  resolveOpenAICredentials,
  sanitizeOpenAIAccountId,
  shouldAllowEmptyAnthropicApiKey,
  shouldAllowEmptyGeminiApiKey,
  shouldUseAnthropicAuthToken,
} from '../src/main/config/auth-utils';

describe('auth-utils', () => {
  beforeEach(() => {
    mocks.importLocalAuthToken.mockReset();
  });

  it('detects oauth-style tokens', () => {
    expect(isLikelyOAuthAccessToken('oauth-access-token')).toBe(true);
    expect(isLikelyOAuthAccessToken('sk-ant-123')).toBe(false);
  });

  it('chooses auth token mode for anthropic oauth tokens', () => {
    expect(
      shouldUseAnthropicAuthToken({
        provider: 'anthropic',
        customProtocol: 'anthropic',
        apiKey: 'oauth-token',
      })
    ).toBe(true);
    expect(
      shouldUseAnthropicAuthToken({
        provider: 'anthropic',
        customProtocol: 'anthropic',
        apiKey: 'sk-ant-abc',
      })
    ).toBe(false);
    expect(
      shouldUseAnthropicAuthToken({
        provider: 'custom',
        customProtocol: 'anthropic',
        apiKey: 'custom-key-without-sk-prefix',
      })
    ).toBe(false);
    expect(
      shouldUseAnthropicAuthToken({
        provider: 'openrouter',
        customProtocol: 'anthropic',
        apiKey: 'sk-or-v1-abc',
      })
    ).toBe(true);
  });

  it('resolves local codex oauth when openai key is empty', () => {
    mocks.importLocalAuthToken.mockReturnValue({
      provider: 'codex',
      token: 'oauth-local-token',
      path: '/tmp/auth.json',
      account: 'user_123456',
    });

    const resolved = resolveOpenAICredentials({
      provider: 'openai',
      customProtocol: 'openai',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(resolved).toEqual({
      apiKey: 'oauth-local-token',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      accountId: 'user_123456',
      useCodexOAuth: true,
      source: 'localCodex',
    });
  });

  it('treats non-sk token on openai provider as codex oauth backend', () => {
    mocks.importLocalAuthToken.mockReturnValue({
      provider: 'codex',
      token: 'oauth-local-token',
      path: '/tmp/auth.json',
      account: 'acct_from_local',
    });

    const resolved = resolveOpenAICredentials({
      provider: 'openai',
      customProtocol: 'openai',
      apiKey: 'oauth-token-from-import',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(resolved).toEqual({
      apiKey: 'oauth-token-from-import',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      accountId: 'acct_from_local',
      useCodexOAuth: true,
      source: 'apiKey',
    });
  });

  it('builds codex headers with optional account id', () => {
    expect(buildOpenAICodexHeaders()).toEqual({
      'User-Agent': 'CodexBar',
    });
    expect(buildOpenAICodexHeaders('acct_abc')).toEqual({
      'User-Agent': 'CodexBar',
      'ChatGPT-Account-Id': 'acct_abc',
    });
  });

  it('sanitizes invalid OpenAI account id values', () => {
    expect(sanitizeOpenAIAccountId('user@example.com')).toBeUndefined();
    expect(sanitizeOpenAIAccountId('abc')).toBeUndefined();
    expect(sanitizeOpenAIAccountId('acct_123456')).toBe('acct_123456');
  });

  it('detects loopback gateway urls', () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:8082')).toBe(true);
    expect(isLoopbackBaseUrl('http://localhost:8082')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:8082')).toBe(true);
    expect(isLoopbackBaseUrl('http://0.0.0.0:8082')).toBe(true);
    expect(isLoopbackBaseUrl('https://api.example.com')).toBe(false);
  });

  it('normalizes anthropic base urls by removing a trailing /v1 segment', () => {
    expect(normalizeAnthropicBaseUrl('https://api.duckcoding.ai/v1')).toBe('https://api.duckcoding.ai');
    expect(normalizeAnthropicBaseUrl('https://proxy.example.com/anthropic/v1/')).toBe('https://proxy.example.com/anthropic');
    expect(normalizeAnthropicBaseUrl('https://proxy.example.com/anthropic')).toBe('https://proxy.example.com/anthropic');
  });

  it('detects official openai base urls', () => {
    expect(isOfficialOpenAIBaseUrl('https://api.openai.com/v1')).toBe(true);
    expect(isOfficialOpenAIBaseUrl('https://chatgpt.com/backend-api/codex')).toBe(true);
    expect(isOfficialOpenAIBaseUrl('https://api.duckcoding.ai/v1')).toBe(false);
    expect(isOfficialOpenAIBaseUrl('https://proxy.example.com/openai')).toBe(false);
  });

  it('flags unsupported custom/openai + official openai base in unified sdk path', () => {
    expect(
      getUnifiedUnsupportedCustomOpenAIBaseUrl({
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: 'sk-test-123',
        baseUrl: 'https://api.openai.com/v1',
      })
    ).toBe('https://api.openai.com/v1');

    expect(
      getUnifiedUnsupportedCustomOpenAIBaseUrl({
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: 'sk-test-123',
        baseUrl: 'https://api.duckcoding.ai/v1',
      })
    ).toBeNull();
  });

  it('allows empty anthropic api key only for custom anthropic loopback gateway', () => {
    expect(
      shouldAllowEmptyAnthropicApiKey({
        provider: 'custom',
        customProtocol: 'anthropic',
        baseUrl: 'http://[::1]:8082',
      })
    ).toBe(true);

    expect(
      shouldAllowEmptyAnthropicApiKey({
        provider: 'custom',
        customProtocol: 'anthropic',
        baseUrl: 'https://proxy.example.com',
      })
    ).toBe(false);

    expect(
      shouldAllowEmptyAnthropicApiKey({
        provider: 'anthropic',
        customProtocol: 'anthropic',
        baseUrl: 'http://127.0.0.1:8082',
      })
    ).toBe(false);
  });

  it('allows empty gemini api key only for custom gemini loopback gateway', () => {
    expect(
      shouldAllowEmptyGeminiApiKey({
        provider: 'custom',
        customProtocol: 'gemini',
        baseUrl: 'http://127.0.0.1:8082',
      })
    ).toBe(true);

    expect(
      shouldAllowEmptyGeminiApiKey({
        provider: 'custom',
        customProtocol: 'gemini',
        baseUrl: 'https://proxy.example.com',
      })
    ).toBe(false);

    expect(
      shouldAllowEmptyGeminiApiKey({
        provider: 'gemini',
        customProtocol: 'gemini',
        baseUrl: 'http://127.0.0.1:8082',
      })
    ).toBe(false);
  });
});
