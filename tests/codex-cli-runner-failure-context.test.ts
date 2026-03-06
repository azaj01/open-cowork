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
    public path = '/tmp/mock-codex-cli-runner-config-store.json';

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

import type { ServerEvent, Session } from '../src/renderer/types';
import { configStore } from '../src/main/config/config-store';
import * as authUtils from '../src/main/config/auth-utils';
import { CodexCliRunner } from '../src/main/openai/codex-cli-runner';

function createSession(id: string): Session {
  return {
    id,
    title: 'runner-test',
    status: 'idle',
    mountedPaths: [],
    allowedTools: [],
    memoryEnabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('CodexCliRunner failure context and cancellation semantics', () => {
  const previousApiKey = configStore.get('apiKey');
  const previousAutoTodo = process.env.COWORK_AUTO_TODO;

  beforeEach(() => {
    configStore.set('apiKey', 'sk-test');
    process.env.COWORK_AUTO_TODO = '1';
  });

  afterEach(() => {
    configStore.set('apiKey', previousApiKey);
    process.env.COWORK_AUTO_TODO = previousAutoTodo;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('attaches empty failure context when codex fails before producing output', async () => {
    const runner = new CodexCliRunner({ sendToRenderer: () => undefined });
    (runner as any).executeCodexProcess = vi.fn().mockRejectedValue(new Error('Codex CLI exited with code 1'));

    let thrown: any;
    try {
      await runner.run(createSession('ctx-1'), 'simple prompt', []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeTruthy();
    expect(thrown.codexFailureContext).toEqual({
      hasTurnOutput: false,
      hasTurnSideEffects: false,
    });
  });

  it('does not pre-report final error when fallback credentials are available via local codex', async () => {
    const events: ServerEvent[] = [];
    const runner = new CodexCliRunner({
      sendToRenderer: (event) => events.push(event),
    });
    configStore.set('apiKey', '');
    vi.spyOn(authUtils, 'resolveOpenAICredentials').mockReturnValue({
      apiKey: 'oauth-local-token',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      useCodexOAuth: true,
      source: 'localCodex',
    });
    (runner as any).executeCodexProcess = vi.fn().mockRejectedValue(new Error('Codex CLI exited with code 1'));

    let thrown: any;
    try {
      await runner.run(createSession('ctx-local-codex'), 'simple prompt', []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeTruthy();
    expect(thrown.alreadyReportedToUser).toBe(false);
    const errorMessages = events.filter(
      (event) =>
        event.type === 'stream.message'
        && event.payload.message.content.some(
          (block) => block.type === 'text' && block.text.includes('**Error**:')
        )
    );
    expect(errorMessages.length).toBe(0);
  });

  it('attaches side-effect context when turn already emitted tool output before failure', async () => {
    const runner = new CodexCliRunner({ sendToRenderer: () => undefined });
    const session = createSession('ctx-2');
    (runner as any).executeCodexProcess = vi.fn().mockImplementation(async () => {
      (runner as any).sendPartial(session.id, 'partial');
      (runner as any).sendMessage(session.id, {
        id: 'msg-tool-use',
        sessionId: session.id,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'execute_command',
            input: { cmd: 'echo hello' },
          },
        ],
        timestamp: Date.now(),
      });
      (runner as any).sendMessage(session.id, {
        id: 'msg-tool-result',
        sessionId: session.id,
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool-1',
            content: 'hello',
            isError: false,
          },
        ],
        timestamp: Date.now(),
      });
      throw new Error('Codex CLI exited with code 1');
    });

    let thrown: any;
    try {
      await runner.run(session, 'simple prompt', []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeTruthy();
    expect(thrown.codexFailureContext).toEqual({
      hasTurnOutput: true,
      hasTurnSideEffects: true,
    });
  });

  it('marks cancelled thinking/todo and does not emit completed on cancellation', async () => {
    vi.useFakeTimers();
    const events: ServerEvent[] = [];
    const runner = new CodexCliRunner({
      sendToRenderer: (event) => events.push(event),
    });
    const session = createSession('ctx-3');

    (runner as any).executeCodexProcess = vi.fn().mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => {
            const cancelledError: any = new Error('Session cancelled');
            cancelledError.isSessionCancelled = true;
            reject(cancelledError);
          }, 3000);
        })
    );

    const runPromise = runner.run(
      session,
      'Please help me use Chrome to search and summarize papers within two days.',
      []
    );
    await vi.advanceTimersByTimeAsync(3500);
    await runPromise;

    const thinkingCompleted = events.find(
      (event) =>
        event.type === 'trace.update' &&
        event.payload.updates.status === 'completed' &&
        event.payload.updates.title === 'Task completed'
    );
    expect(thinkingCompleted).toBeUndefined();

    const cancelledThinking = events.find(
      (event) =>
        event.type === 'trace.update' &&
        event.payload.updates.status === 'error' &&
        event.payload.updates.title === 'Cancelled'
    );
    expect(cancelledThinking).toBeTruthy();

    const todoToolUses = events.filter(
      (event) =>
        event.type === 'stream.message' &&
        event.payload.message.content.some(
          (block) => block.type === 'tool_use' && block.name === 'TodoWrite'
        )
    );
    expect(todoToolUses.length).toBeGreaterThanOrEqual(2);

    const latestTodoMessage = todoToolUses[todoToolUses.length - 1] as Extract<
      ServerEvent,
      { type: 'stream.message' }
    >;
    const latestTodoUse = latestTodoMessage.payload.message.content.find(
      (block) => block.type === 'tool_use' && block.name === 'TodoWrite'
    );
    expect(latestTodoUse && latestTodoUse.type === 'tool_use').toBe(true);
    if (latestTodoUse && latestTodoUse.type === 'tool_use') {
      const statuses = (latestTodoUse.input.todos as Array<{ status: string }>).map((todo) => todo.status);
      expect(statuses.every((status) => status === 'cancelled' || status === 'completed')).toBe(true);
      expect(statuses.includes('cancelled')).toBe(true);
    }
  });

  it('bubbles direct screen-interpretation failure with failure context', async () => {
    const mcpManager = {
      getTool: vi.fn(() => ({})),
      getTools: vi.fn(() => []),
      getServerStatus: vi.fn(() => []),
      callTool: vi.fn(async (toolName: string) => {
        if (toolName.endsWith('__screenshot_for_display')) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, path: '/tmp/screen.png' }) }],
          };
        }
        throw new Error('Vision API failed after 3 attempts: API request failed: 400 Bad Request');
      }),
    };

    const runner = new CodexCliRunner({
      sendToRenderer: () => undefined,
      mcpManager: mcpManager as any,
    });

    let thrown: any;
    try {
      await runner.run(createSession('ctx-4'), '截图 并为我解读屏幕信息', []);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeTruthy();
    expect(thrown.codexFailureContext).toEqual({
      hasTurnOutput: true,
      hasTurnSideEffects: true,
    });
  });
});
