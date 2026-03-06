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

import { configStore } from '../src/main/config/config-store';
import { SessionManager } from '../src/main/session/session-manager';

interface RunnerSelectionHarness {
  openaiBackendRoute: string | null;
  agentRunner: unknown;
  createClaudeAgentRunner: () => unknown;
  createOpenAIResponsesRunner: () => unknown;
  createCodexCliRunner: () => unknown;
  shouldForceResponsesFallback: () => boolean;
}

const sessionManagerProto = SessionManager.prototype as unknown as {
  createAgentRunner(this: RunnerSelectionHarness): void;
};

describe('SessionManager runner selection', () => {
  const previous = {
    provider: configStore.get('provider'),
    customProtocol: configStore.get('customProtocol'),
    apiKey: configStore.get('apiKey'),
    disableClaudeUnified: process.env.COWORK_DISABLE_CLAUDE_UNIFIED,
    forceClaudeAgentSdk: process.env.COWORK_FORCE_CLAUDE_AGENT_SDK,
  };

  beforeEach(() => {
    configStore.set('provider', 'openai');
    configStore.set('customProtocol', 'openai');
    configStore.set('apiKey', 'sk-test');
    delete process.env.COWORK_DISABLE_CLAUDE_UNIFIED;
    delete process.env.COWORK_FORCE_CLAUDE_AGENT_SDK;
  });

  afterEach(() => {
    configStore.set('provider', previous.provider);
    configStore.set('customProtocol', previous.customProtocol);
    configStore.set('apiKey', previous.apiKey);
    if (previous.disableClaudeUnified === undefined) {
      delete process.env.COWORK_DISABLE_CLAUDE_UNIFIED;
    } else {
      process.env.COWORK_DISABLE_CLAUDE_UNIFIED = previous.disableClaudeUnified;
    }
    if (previous.forceClaudeAgentSdk === undefined) {
      delete process.env.COWORK_FORCE_CLAUDE_AGENT_SDK;
    } else {
      process.env.COWORK_FORCE_CLAUDE_AGENT_SDK = previous.forceClaudeAgentSdk;
    }
    vi.restoreAllMocks();
  });

  it('uses Claude Agent SDK runner by default', () => {
    const claudeRunner = {
      run: vi.fn(),
      cancel: vi.fn(),
      handleQuestionResponse: vi.fn(),
    };
    const fakeManager: RunnerSelectionHarness = {
      openaiBackendRoute: 'codex-cli',
      agentRunner: null,
      createClaudeAgentRunner: vi.fn(() => claudeRunner),
      createOpenAIResponsesRunner: vi.fn(() => ({
        run: vi.fn(),
        cancel: vi.fn(),
        handleQuestionResponse: vi.fn(),
      })),
      createCodexCliRunner: vi.fn(() => ({
        run: vi.fn(),
        cancel: vi.fn(),
        handleQuestionResponse: vi.fn(),
      })),
      shouldForceResponsesFallback: vi.fn(() => false),
    };

    sessionManagerProto.createAgentRunner.call(fakeManager);

    expect(fakeManager.createClaudeAgentRunner).toHaveBeenCalledTimes(1);
    expect(fakeManager.createOpenAIResponsesRunner).not.toHaveBeenCalled();
    expect(fakeManager.createCodexCliRunner).not.toHaveBeenCalled();
    expect(fakeManager.openaiBackendRoute).toBeNull();
    expect(fakeManager.agentRunner).toBe(claudeRunner);
  });

  it('falls back to legacy openai runner when unified mode is disabled', () => {
    process.env.COWORK_DISABLE_CLAUDE_UNIFIED = '1';
    const codexRunner = {
      run: vi.fn(),
      cancel: vi.fn(),
      handleQuestionResponse: vi.fn(),
    };
    const fakeManager: RunnerSelectionHarness = {
      openaiBackendRoute: null,
      agentRunner: null,
      createClaudeAgentRunner: vi.fn(() => ({
        run: vi.fn(),
        cancel: vi.fn(),
        handleQuestionResponse: vi.fn(),
      })),
      createOpenAIResponsesRunner: vi.fn(() => ({
        run: vi.fn(),
        cancel: vi.fn(),
        handleQuestionResponse: vi.fn(),
      })),
      createCodexCliRunner: vi.fn(() => codexRunner),
      shouldForceResponsesFallback: vi.fn(() => false),
    };

    sessionManagerProto.createAgentRunner.call(fakeManager);

    expect(fakeManager.createClaudeAgentRunner).not.toHaveBeenCalled();
    expect(fakeManager.createCodexCliRunner).toHaveBeenCalledTimes(1);
    expect(fakeManager.openaiBackendRoute).toBe('codex-cli');
    expect(fakeManager.agentRunner).toBe(codexRunner);
  });
});
