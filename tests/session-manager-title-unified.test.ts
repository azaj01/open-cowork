import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

vi.mock('../src/main/claude/agent-runner', () => ({
  ClaudeAgentRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

vi.mock('../src/main/auth/local-auth', () => ({
  importLocalAuthToken: vi.fn(() => ({
    provider: 'codex',
    token: 'oauth-local-token',
    path: '/tmp/codex-auth.json',
  })),
}));

vi.mock('../src/main/claude/claude-sdk-one-shot', () => ({
  generateTitleWithClaudeSdk: vi.fn(async () => 'Unified Title'),
}));

import { configStore } from '../src/main/config/config-store';
import { SessionManager } from '../src/main/session/session-manager';
import { generateTitleWithClaudeSdk } from '../src/main/claude/claude-sdk-one-shot';

const mockedGenerateTitleWithClaudeSdk = vi.mocked(generateTitleWithClaudeSdk);

describe('SessionManager unified title generation', () => {
  const previous = {
    disableClaudeUnified: process.env.COWORK_DISABLE_CLAUDE_UNIFIED,
    provider: configStore.get('provider'),
    customProtocol: configStore.get('customProtocol'),
    apiKey: configStore.get('apiKey'),
    model: configStore.get('model'),
  };

  beforeEach(() => {
    delete process.env.COWORK_DISABLE_CLAUDE_UNIFIED;
    configStore.set('provider', 'openai');
    configStore.set('customProtocol', 'openai');
    configStore.set('apiKey', 'sk-test');
    configStore.set('model', 'gpt-4.1');
    mockedGenerateTitleWithClaudeSdk.mockClear();
  });

  afterEach(() => {
    if (previous.disableClaudeUnified === undefined) {
      delete process.env.COWORK_DISABLE_CLAUDE_UNIFIED;
    } else {
      process.env.COWORK_DISABLE_CLAUDE_UNIFIED = previous.disableClaudeUnified;
    }
    configStore.set('provider', previous.provider);
    configStore.set('customProtocol', previous.customProtocol);
    configStore.set('apiKey', previous.apiKey);
    configStore.set('model', previous.model);
    vi.restoreAllMocks();
  });

  it('routes title generation through Claude SDK in unified mode', async () => {
    const proto = SessionManager.prototype as unknown as {
      generateTitleWithConfig(titlePrompt: string): Promise<string | null>;
    };

    const title = await proto.generateTitleWithConfig.call({}, 'Please generate title');

    expect(title).toBe('Unified Title');
    expect(mockedGenerateTitleWithClaudeSdk).toHaveBeenCalledTimes(1);
    expect(mockedGenerateTitleWithClaudeSdk).toHaveBeenCalledWith(
      'Please generate title',
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-4.1',
      }),
      undefined
    );
  });
});
