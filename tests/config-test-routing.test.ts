import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiTestResult } from '../src/renderer/types';
import type { AppConfig } from '../src/main/config/config-store';

const mocks = vi.hoisted(() => ({
  probeWithClaudeSdk: vi.fn(),
  testApiConnection: vi.fn(),
  importLocalAuthToken: vi.fn(),
}));

vi.mock('../src/main/claude/claude-sdk-one-shot', () => ({
  probeWithClaudeSdk: mocks.probeWithClaudeSdk,
}));

vi.mock('../src/main/config/api-tester', () => ({
  testApiConnection: mocks.testApiConnection,
}));

vi.mock('../src/main/auth/local-auth', () => ({
  importLocalAuthToken: mocks.importLocalAuthToken,
}));

import { runConfigApiTest } from '../src/main/config/config-test-routing';

function createConfig(): AppConfig {
  return {
    provider: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    customProtocol: 'openai',
    model: 'gpt-4.1',
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
  };
}

describe('runConfigApiTest', () => {
  beforeEach(() => {
    mocks.probeWithClaudeSdk.mockReset();
    mocks.testApiConnection.mockReset();
    mocks.importLocalAuthToken.mockReset();
    mocks.importLocalAuthToken.mockReturnValue(null);
  });

  it('routes config.test to Claude SDK probe when unified mode is enabled', async () => {
    const expected: ApiTestResult = { ok: true, latencyMs: 12 };
    mocks.probeWithClaudeSdk.mockResolvedValue(expected);

    const result = await runConfigApiTest(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createConfig(),
      true
    );

    expect(result).toEqual(expected);
    expect(mocks.probeWithClaudeSdk).toHaveBeenCalledTimes(1);
    expect(mocks.testApiConnection).not.toHaveBeenCalled();
  });

  it('routes config.test to legacy api tester when unified mode is disabled', async () => {
    const expected: ApiTestResult = { ok: false, errorType: 'unauthorized' };
    mocks.testApiConnection.mockResolvedValue(expected);

    const result = await runConfigApiTest(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createConfig(),
      false
    );

    expect(result).toEqual(expected);
    expect(mocks.testApiConnection).toHaveBeenCalledTimes(1);
    expect(mocks.probeWithClaudeSdk).not.toHaveBeenCalled();
  });

  it('keeps gemini config.test on Claude SDK probe even when unified mode flag is disabled', async () => {
    const expected: ApiTestResult = { ok: true, latencyMs: 18 };
    mocks.probeWithClaudeSdk.mockResolvedValue(expected);

    const result = await runConfigApiTest(
      {
        provider: 'gemini',
        customProtocol: 'gemini',
        apiKey: 'AIza-test',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini/gemini-2.5-flash',
      },
      {
        ...createConfig(),
        provider: 'gemini',
        customProtocol: 'gemini',
        activeProfileKey: 'gemini',
        apiKey: 'AIza-test',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini/gemini-2.5-flash',
      },
      false
    );

    expect(result).toEqual(expected);
    expect(mocks.probeWithClaudeSdk).toHaveBeenCalledTimes(1);
    expect(mocks.testApiConnection).not.toHaveBeenCalled();
  });

  it('does not fall back to legacy tester when unified probe cannot find Claude executable', async () => {
    const probeFailure: ApiTestResult = {
      ok: false,
      errorType: 'unknown',
      details: 'Claude Code executable not found. Please install @anthropic-ai/claude-code',
    };
    mocks.probeWithClaudeSdk.mockResolvedValue(probeFailure);

    const result = await runConfigApiTest(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createConfig(),
      true
    );

    expect(result).toEqual(probeFailure);
    expect(mocks.probeWithClaudeSdk).toHaveBeenCalledTimes(1);
    expect(mocks.testApiConnection).not.toHaveBeenCalled();
  });

  it('does not fall back to legacy tester when unified probe hits protocol-level mismatch', async () => {
    const probeFailure: ApiTestResult = {
      ok: false,
      errorType: 'unknown',
      details: 'probe_response_mismatch:pong',
    };
    mocks.probeWithClaudeSdk.mockResolvedValue(probeFailure);

    const result = await runConfigApiTest(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createConfig(),
      true
    );

    expect(result).toEqual(probeFailure);
    expect(mocks.probeWithClaudeSdk).toHaveBeenCalledTimes(1);
    expect(mocks.testApiConnection).not.toHaveBeenCalled();
  });

  it('does not retry legacy tester when unified probe returns unauthorized for explicit key', async () => {
    const probeFailure: ApiTestResult = {
      ok: false,
      errorType: 'unauthorized',
      details: '401 Unauthorized',
    };
    mocks.probeWithClaudeSdk.mockResolvedValue(probeFailure);
    mocks.importLocalAuthToken.mockReturnValue({ token: 'oauth-local-token', account: 'acct-123' });

    const result = await runConfigApiTest(
      {
        provider: 'openai',
        apiKey: 'sk-explicit',
        model: 'gpt-4.1',
      },
      createConfig(),
      true
    );

    expect(result).toEqual(probeFailure);
    expect(mocks.probeWithClaudeSdk).toHaveBeenCalledTimes(1);
    expect(mocks.testApiConnection).not.toHaveBeenCalled();
  });
});
