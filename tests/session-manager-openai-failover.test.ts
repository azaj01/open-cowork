import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-session-manager-openai-failover-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
      };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = {
        ...this.store,
        ...key,
      };
    }

    clear(): void {
      this.store = {};
    }
  }

  return {
    default: MockStore,
  };
});

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

vi.mock('../src/main/claude/agent-runner', () => ({
  ClaudeAgentRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
  },
}));

vi.mock('../src/main/openai/responses-runner', () => ({
  OpenAIResponsesRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
  },
}));

import type { Message, Session } from '../src/renderer/types';
import { configStore } from '../src/main/config/config-store';
import * as authUtils from '../src/main/config/auth-utils';
import { CodexCliRunner } from '../src/main/openai/codex-cli-runner';
import { SessionManager } from '../src/main/session/session-manager';

function createSession(id: string): Session {
  return {
    id,
    title: 'test',
    status: 'idle',
    mountedPaths: [],
    allowedTools: [],
    memoryEnabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('SessionManager OpenAI failover guard', () => {
  const previous = {
    provider: configStore.get('provider'),
    customProtocol: configStore.get('customProtocol'),
    apiKey: configStore.get('apiKey'),
    baseUrl: configStore.get('baseUrl'),
  };

  beforeEach(() => {
    configStore.set('provider', 'openai');
    configStore.set('customProtocol', 'openai');
    configStore.set('apiKey', 'sk-test');
    configStore.set('baseUrl', 'https://api.openai.com/v1');
  });

  afterEach(() => {
    configStore.set('provider', previous.provider);
    configStore.set('customProtocol', previous.customProtocol);
    configStore.set('apiKey', previous.apiKey);
    configStore.set('baseUrl', previous.baseUrl);
    vi.restoreAllMocks();
  });

  it('blocks fallback rerun when codex turn already had side effects', async () => {
    const fallbackRun = vi.fn().mockResolvedValue(undefined);
    const fakeManager = {
      openaiBackendRoute: 'codex-cli',
      agentRunner: new CodexCliRunner({ sendToRenderer: () => undefined }),
      responsesFallbackRunnerBySession: new Map(),
      createOpenAIResponsesRunner: () => ({ run: fallbackRun, cancel: vi.fn() }),
      extractCodexFailureContext: (SessionManager.prototype as any).extractCodexFailureContext,
    } as any;

    const error: any = new Error('Codex CLI exited with code 1: runtime');
    error.codexFailureContext = {
      hasTurnOutput: true,
      hasTurnSideEffects: true,
    };

    const result = await (SessionManager.prototype as any).tryRunOpenAIResponsesFallback.call(
      fakeManager,
      createSession('s-1'),
      'prompt',
      [] as Message[],
      error
    );

    expect(result).toBe(false);
    expect(fallbackRun).not.toHaveBeenCalled();
  });

  it('runs responses fallback when codex failed before any output/side effects', async () => {
    const fallbackRun = vi.fn().mockResolvedValue(undefined);
    const fakeManager = {
      openaiBackendRoute: 'codex-cli',
      agentRunner: new CodexCliRunner({ sendToRenderer: () => undefined }),
      responsesFallbackRunnerBySession: new Map(),
      createOpenAIResponsesRunner: () => ({ run: fallbackRun, cancel: vi.fn() }),
      extractCodexFailureContext: (SessionManager.prototype as any).extractCodexFailureContext,
    } as any;

    const error: any = new Error('Codex CLI exited with code 1: runtime');
    error.codexFailureContext = {
      hasTurnOutput: false,
      hasTurnSideEffects: false,
    };

    const session = createSession('s-2');
    const result = await (SessionManager.prototype as any).tryRunOpenAIResponsesFallback.call(
      fakeManager,
      session,
      'prompt',
      [] as Message[],
      error
    );

    expect(result).toBe(true);
    expect(fallbackRun).toHaveBeenCalledTimes(1);
    expect(fallbackRun).toHaveBeenCalledWith(session, 'prompt', []);
  });

  it('allows fallback when apiKey is empty but resolved OpenAI credentials exist', async () => {
    configStore.set('apiKey', '');
    vi.spyOn(authUtils, 'resolveOpenAICredentials').mockReturnValue({
      apiKey: 'oauth-local-token',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      useCodexOAuth: true,
      source: 'localCodex',
    });

    const fallbackRun = vi.fn().mockResolvedValue(undefined);
    const fakeManager = {
      openaiBackendRoute: 'codex-cli',
      agentRunner: new CodexCliRunner({ sendToRenderer: () => undefined }),
      responsesFallbackRunnerBySession: new Map(),
      createOpenAIResponsesRunner: () => ({ run: fallbackRun, cancel: vi.fn() }),
      extractCodexFailureContext: (SessionManager.prototype as any).extractCodexFailureContext,
    } as any;

    const error: any = new Error('Codex CLI exited with code 1: runtime');
    error.codexFailureContext = {
      hasTurnOutput: false,
      hasTurnSideEffects: false,
    };

    const result = await (SessionManager.prototype as any).tryRunOpenAIResponsesFallback.call(
      fakeManager,
      createSession('s-local-auth'),
      'prompt',
      [] as Message[],
      error
    );

    expect(result).toBe(true);
    expect(fallbackRun).toHaveBeenCalledTimes(1);
  });

  it('does not fallback for unauthorized error without codex context', async () => {
    const fallbackRun = vi.fn().mockResolvedValue(undefined);
    const fakeManager = {
      openaiBackendRoute: 'codex-cli',
      agentRunner: new CodexCliRunner({ sendToRenderer: () => undefined }),
      responsesFallbackRunnerBySession: new Map(),
      createOpenAIResponsesRunner: () => ({ run: fallbackRun, cancel: vi.fn() }),
      extractCodexFailureContext: (SessionManager.prototype as any).extractCodexFailureContext,
    } as any;

    const error: any = new Error('upstream unauthorized');
    error.codexFailureContext = {
      hasTurnOutput: false,
      hasTurnSideEffects: false,
    };

    const result = await (SessionManager.prototype as any).tryRunOpenAIResponsesFallback.call(
      fakeManager,
      createSession('s-unauthorized'),
      'prompt',
      [] as Message[],
      error
    );

    expect(result).toBe(false);
    expect(fallbackRun).not.toHaveBeenCalled();
  });

  it('does not fallback for cancelled errors', async () => {
    const fallbackRun = vi.fn().mockResolvedValue(undefined);
    const fakeManager = {
      openaiBackendRoute: 'codex-cli',
      agentRunner: new CodexCliRunner({ sendToRenderer: () => undefined }),
      responsesFallbackRunnerBySession: new Map(),
      createOpenAIResponsesRunner: () => ({ run: fallbackRun, cancel: vi.fn() }),
      extractCodexFailureContext: (SessionManager.prototype as any).extractCodexFailureContext,
    } as any;

    const error = new Error('AbortError: The operation was aborted');
    const result = await (SessionManager.prototype as any).tryRunOpenAIResponsesFallback.call(
      fakeManager,
      createSession('s-3'),
      'prompt',
      [] as Message[],
      error
    );

    expect(result).toBe(false);
    expect(fallbackRun).not.toHaveBeenCalled();
  });

  it('routes question responses to fallback runner and primary runner', () => {
    const fallbackRunner = {
      handleQuestionResponse: vi.fn(),
    };
    const primaryRunner = {
      handleQuestionResponse: vi.fn(),
    };
    const fakeManager = {
      responsesFallbackRunnerBySession: new Map([['s-1', fallbackRunner]]),
      agentRunner: primaryRunner,
    } as any;

    (SessionManager.prototype as any).handleQuestionResponse.call(fakeManager, 'question-1', '{"0":["A"]}');

    expect(fallbackRunner.handleQuestionResponse).toHaveBeenCalledWith('question-1', '{"0":["A"]}');
    expect(primaryRunner.handleQuestionResponse).toHaveBeenCalledWith('question-1', '{"0":["A"]}');
  });

  it('updates mounted paths and emits session.update when cwd changes', () => {
    const updateSpy = vi.fn();
    const sendSpy = vi.fn();
    const clearSdkSessionSpy = vi.fn();
    const fakeManager = {
      activeSessions: new Map(),
      db: {
        sessions: {
          update: updateSpy,
        },
      },
      sendToRenderer: sendSpy,
      agentRunner: {
        clearSdkSession: clearSdkSessionSpy,
      },
      buildMountedPaths: (SessionManager.prototype as any).buildMountedPaths,
    } as any;

    (SessionManager.prototype as any).updateSessionCwd.call(fakeManager, 'session-1', '/tmp/project');

    expect(updateSpy).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        cwd: '/tmp/project',
        mounted_paths: JSON.stringify([{ virtual: '/mnt/workspace', real: '/tmp/project' }]),
        claude_session_id: null,
        openai_thread_id: null,
        updated_at: expect.any(Number),
      })
    );
    expect(clearSdkSessionSpy).toHaveBeenCalledWith('session-1');
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'session.update',
      payload: {
        sessionId: 'session-1',
        updates: {
          cwd: '/tmp/project',
          mountedPaths: [{ virtual: '/mnt/workspace', real: '/tmp/project' }],
        },
      },
    });
  });

  it('does not release active session lock immediately during stopSession', () => {
    const abortSpy = vi.fn();
    const controller = { abort: abortSpy } as unknown as AbortController;
    const fallbackRunner = { cancel: vi.fn() };
    const fakeManager = {
      titleGenerationTokens: new Map([['session-1', Symbol('title')]]),
      agentRunner: { cancel: vi.fn() },
      responsesFallbackRunnerBySession: new Map([['session-1', fallbackRunner]]),
      activeSessions: new Map([['session-1', controller]]),
      promptQueues: new Map([['session-1', [{ prompt: 'p' }]]]),
      updateSessionStatus: vi.fn(),
    } as any;

    (SessionManager.prototype as any).stopSession.call(fakeManager, 'session-1');

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(fakeManager.activeSessions.has('session-1')).toBe(true);
    expect(fallbackRunner.cancel).toHaveBeenCalledWith('session-1');
    expect(fakeManager.responsesFallbackRunnerBySession.has('session-1')).toBe(true);
  });

  it('stops active run before updating cwd', () => {
    const updateSpy = vi.fn();
    const sendSpy = vi.fn();
    const stopSpy = vi.fn();
    const fakeManager = {
      activeSessions: new Map([['session-2', { abort: vi.fn() }]]),
      stopSession: stopSpy,
      db: {
        sessions: {
          update: updateSpy,
        },
      },
      sendToRenderer: sendSpy,
      agentRunner: {
        clearSdkSession: vi.fn(),
      },
      buildMountedPaths: (SessionManager.prototype as any).buildMountedPaths,
    } as any;

    (SessionManager.prototype as any).updateSessionCwd.call(fakeManager, 'session-2', '/tmp/new-cwd');

    expect(stopSpy).toHaveBeenCalledWith('session-2');
    expect(updateSpy).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({
        cwd: '/tmp/new-cwd',
      })
    );
  });
});
