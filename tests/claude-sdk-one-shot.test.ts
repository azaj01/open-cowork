import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/main/config/config-store';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveClaudeCodeExecutablePath: vi.fn(),
  ensureProxyReady: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query,
}));

vi.mock('../src/main/claude/claude-code-path', () => ({
  resolveClaudeCodeExecutablePath: mocks.resolveClaudeCodeExecutablePath,
}));

vi.mock('../src/main/proxy/claude-proxy-manager', () => ({
  claudeProxyManager: {
    ensureReady: mocks.ensureProxyReady,
  },
}));

vi.mock('../src/main/session/claude-unified-mode', () => ({
  isClaudeUnifiedModeEnabled: () => true,
}));

vi.mock('../src/main/auth/local-auth', () => ({
  importLocalAuthToken: vi.fn(() => null),
}));

import { generateTitleWithClaudeSdk, probeWithClaudeSdk } from '../src/main/claude/claude-sdk-one-shot';

function streamFrom(messages: unknown[]) {
  return (async function* () {
    for (const message of messages) {
      yield message as never;
    }
  })();
}

function streamFromWithThrow(messages: unknown[], error: Error) {
  return (async function* () {
    for (const message of messages) {
      yield message as never;
    }
    throw error;
  })();
}

function createBaseConfig(): AppConfig {
  return {
    provider: 'anthropic',
    apiKey: 'sk-ant-test',
    baseUrl: 'https://api.anthropic.com',
    customProtocol: 'anthropic',
    model: 'claude-sonnet-4-5',
    openaiMode: 'responses',
    activeProfileKey: 'anthropic',
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

describe('claude-sdk-one-shot', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.resolveClaudeCodeExecutablePath.mockReset();
    mocks.ensureProxyReady.mockReset();
    mocks.resolveClaudeCodeExecutablePath.mockReturnValue({
      executablePath: '/opt/homebrew/bin/claude',
      source: 'test.stub',
    });
    mocks.ensureProxyReady.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:18082',
      host: '127.0.0.1',
      port: 18082,
      upstreamKind: 'anthropic',
      signature: 'test-signature',
      sdkApiKey: 'sk-ant-local-proxy',
      pid: 9999,
    });
  });

  it('returns success for sdk probe when assistant responds without errors', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'sdk_probe_ok' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'sdk_probe_ok',
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeTypeOf('number');
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          cwd: process.cwd(),
          pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
          spawnClaudeCodeProcess: expect.any(Function),
          stderr: expect.any(Function),
          env: expect.objectContaining({
            CLAUDE_CONFIG_DIR: expect.any(String),
          }),
        }),
      })
    );
    const callArg = mocks.query.mock.calls[0]?.[0] as { options?: Record<string, unknown> } | undefined;
    expect(callArg?.options).not.toHaveProperty('settingSources');
  });

  it('maps authentication_failed to unauthorized', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          error: 'authentication_failed',
          message: { content: [] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'bad-key',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unauthorized');
  });

  it('maps unauthorized text variants to unauthorized', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['HTTP 401 Unauthorized'],
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'bad-key',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unauthorized');
  });

  it('maps 403 forbidden variants to unauthorized', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['HTTP 403 Forbidden'],
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'bad-key',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unauthorized');
  });

  it('uses result errors for success+is_error payloads instead of degrading to generic subtype text', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: '',
          errors: ['HTTP 401 Unauthorized'],
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'bad-key',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unauthorized');
    expect(result.details).toContain('401');
  });

  it('maps rate_limit errors from result messages', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['rate_limit'],
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('rate_limited');
  });

  it('returns missing_base_url for custom provider without base url', async () => {
    const result = await probeWithClaudeSdk(
      {
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('missing_base_url');
  });

  it('routes custom/openai official openai base through proxy', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'sdk_probe_ok' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'sdk_probe_ok',
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.3-codex',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(true);
    expect(mocks.ensureProxyReady).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamKind: 'openai',
        upstreamBaseUrl: 'https://api.openai.com/v1',
        upstreamApiKey: 'sk-test',
      })
    );
  });

  it('normalizes title output from sdk response', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '"  My Session Title  "\nIgnore this line' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
        },
      ])
    );

    const title = await generateTitleWithClaudeSdk('Generate title', createBaseConfig());
    expect(title).toBe('My Session Title');
  });

  it('generates title for custom/openai official openai base via proxy', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'OpenAI Profile Session' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
        },
      ])
    );

    const title = await generateTitleWithClaudeSdk(
      'Generate title',
      {
        ...createBaseConfig(),
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.3-codex',
      }
    );

    expect(title).toBe('OpenAI Profile Session');
    expect(mocks.ensureProxyReady).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamKind: 'openai',
        upstreamBaseUrl: 'https://api.openai.com/v1',
      })
    );
  });

  it('returns unknown when probe response is empty without explicit errors', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unknown');
    expect(result.details).toBe('empty_probe_response');
  });

  it('fails probe when response does not match expected ack token', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'pong' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'pong',
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unknown');
    expect(result.details).toContain('probe_response_mismatch');
  });

  it('returns missing_key when openai credentials are not available', async () => {
    const config = createBaseConfig();
    config.apiKey = '';
    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: '',
        model: 'gpt-4.1',
      },
      config
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('missing_key');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('reuses saved config api key when probe input apiKey is empty', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'sdk_probe_ok' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'sdk_probe_ok',
        },
      ])
    );
    const config = createBaseConfig();
    config.provider = 'openai';
    config.customProtocol = 'openai';
    config.apiKey = 'sk-saved-key';

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: '',
        model: 'gpt-4.1',
      },
      config
    );

    expect(result.ok).toBe(true);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('uses result payload text when non-success result omits errors array', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'HTTP 401 Unauthorized',
        },
      ])
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'bad-key',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unauthorized');
  });

  it('preserves sdk error details when process exits after error result', async () => {
    mocks.query.mockReturnValue(
      streamFromWithThrow(
        [
          {
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: 'Invalid API key · Please run /login',
          },
        ],
        new Error('Claude Code process exited with code 1')
      )
    );

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'bad-key',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unauthorized');
    expect(result.details).toContain('Invalid API key');
  });

  it('falls back to process cwd when configured defaultWorkdir does not exist', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'sdk_probe_ok' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'sdk_probe_ok',
        },
      ])
    );

    const config = createBaseConfig();
    config.defaultWorkdir = '/path/that/does/not/exist';
    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      config
    );

    expect(result.ok).toBe(true);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          cwd: process.cwd(),
        }),
      })
    );
  });

  it('returns unknown when Claude Code executable cannot be resolved', async () => {
    mocks.resolveClaudeCodeExecutablePath.mockReturnValue(null);

    const result = await probeWithClaudeSdk(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
      createBaseConfig()
    );

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe('unknown');
    expect(result.details).toContain('Claude Code executable not found');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('normalizes trailing /v1 in custom anthropic probe base url before proxy routing', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'sdk_probe_ok' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'sdk_probe_ok',
        },
      ])
    );

    const config = createBaseConfig();
    config.provider = 'custom';
    config.customProtocol = 'anthropic';
    config.baseUrl = 'https://api.duckcoding.ai/v1';

    const result = await probeWithClaudeSdk(
      {
        provider: 'custom',
        customProtocol: 'anthropic',
        apiKey: 'sk-test',
        baseUrl: 'https://api.duckcoding.ai/v1',
        model: 'gpt-5.3-codex',
      },
      config
    );

    expect(result.ok).toBe(true);
    expect(mocks.ensureProxyReady).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamKind: 'anthropic',
        upstreamBaseUrl: 'https://api.duckcoding.ai',
      })
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:18082',
            ANTHROPIC_API_KEY: 'sk-ant-local-proxy',
          }),
        }),
      })
    );
  });

  it('routes custom openai credentials through proxy instead of direct env mirroring', async () => {
    mocks.query.mockReturnValue(
      streamFrom([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'sdk_probe_ok' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'sdk_probe_ok',
        },
      ])
    );

    const config = createBaseConfig();
    config.provider = 'custom';
    config.customProtocol = 'openai';
    config.baseUrl = 'https://api.duckcoding.ai/v1';
    config.model = 'gpt-5.3-codex';

    const result = await probeWithClaudeSdk(
      {
        provider: 'custom',
        customProtocol: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.duckcoding.ai/v1',
        model: 'gpt-5.3-codex',
      },
      config
    );

    expect(result.ok).toBe(true);
    expect(mocks.ensureProxyReady).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamKind: 'openai',
        upstreamBaseUrl: 'https://api.duckcoding.ai/v1',
        upstreamApiKey: 'sk-test',
      })
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:18082',
            ANTHROPIC_API_KEY: 'sk-ant-local-proxy',
          }),
        }),
      })
    );
  });
});
