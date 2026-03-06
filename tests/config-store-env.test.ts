import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store-env.json';

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

import { ConfigStore } from '../src/main/config/config-store';

describe('ConfigStore applyToEnv', () => {
  const originalEnv = {
    CLAUDE_CODE_PATH: process.env.CLAUDE_CODE_PATH,
    COWORK_WORKDIR: process.env.COWORK_WORKDIR,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OPENAI_API_MODE: process.env.OPENAI_API_MODE,
  };

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_PATH;
    delete process.env.COWORK_WORKDIR;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_API_MODE;
  });

  afterEach(() => {
    if (originalEnv.CLAUDE_CODE_PATH === undefined) {
      delete process.env.CLAUDE_CODE_PATH;
    } else {
      process.env.CLAUDE_CODE_PATH = originalEnv.CLAUDE_CODE_PATH;
    }
    if (originalEnv.COWORK_WORKDIR === undefined) {
      delete process.env.COWORK_WORKDIR;
    } else {
      process.env.COWORK_WORKDIR = originalEnv.COWORK_WORKDIR;
    }
    if (originalEnv.ANTHROPIC_API_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    }
    if (originalEnv.ANTHROPIC_BASE_URL === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalEnv.ANTHROPIC_BASE_URL;
    }
    if (originalEnv.OPENAI_API_MODE === undefined) {
      delete process.env.OPENAI_API_MODE;
    } else {
      process.env.OPENAI_API_MODE = originalEnv.OPENAI_API_MODE;
    }
  });

  it('clears stale CLAUDE_CODE_PATH and COWORK_WORKDIR when config values are removed', async () => {
    const store = new ConfigStore();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-config-env-'));
    const validClaudePath = path.join(tempDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    try {
      fs.mkdirSync(path.dirname(validClaudePath), { recursive: true });
      fs.writeFileSync(validClaudePath, '#!/usr/bin/env node\n', 'utf-8');

      store.update({
        claudeCodePath: validClaudePath,
        defaultWorkdir: '/tmp/cowork-valid-workdir',
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5',
      });
      store.applyToEnv();
      expect(process.env.CLAUDE_CODE_PATH).toBe(validClaudePath);
      expect(process.env.COWORK_WORKDIR).toBe('/tmp/cowork-valid-workdir');

      store.update({
        claudeCodePath: '',
        defaultWorkdir: '',
      });
      store.applyToEnv();

      expect(process.env.CLAUDE_CODE_PATH).toBeUndefined();
      expect(process.env.COWORK_WORKDIR).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not export known-invalid dist-electron main cli path to CLAUDE_CODE_PATH', async () => {
    const store = new ConfigStore();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-invalid-claude-path-'));
    const invalidPath = path.join(tempDir, 'dist-electron', 'main', 'cli.js');
    try {
      fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
      fs.writeFileSync(invalidPath, '// not claude-code cli\n', 'utf-8');

      process.env.CLAUDE_CODE_PATH = '/tmp/stale-value';

      store.update({
        claudeCodePath: invalidPath,
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-5',
      });
      store.applyToEnv();

      expect(process.env.CLAUDE_CODE_PATH).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('exports loopback placeholder key for custom anthropic profile when api key is empty', () => {
    const store = new ConfigStore();

    store.update({
      provider: 'custom',
      customProtocol: 'anthropic',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8082',
      model: 'openai/gpt-4.1-mini',
    });
    store.applyToEnv();

    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-local-proxy');
  });

  it('preserves configured OPENAI_API_MODE when applying OpenAI env', () => {
    const store = new ConfigStore();

    store.update({
      provider: 'openai',
      customProtocol: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4.1',
      openaiMode: 'chat',
    });
    store.applyToEnv();

    expect(process.env.OPENAI_API_MODE).toBe('chat');
  });

  it('normalizes trailing /v1 for anthropic-compatible base url when applying env', () => {
    const store = new ConfigStore();

    store.update({
      provider: 'custom',
      customProtocol: 'anthropic',
      apiKey: 'sk-test',
      baseUrl: 'https://api.duckcoding.ai/v1',
      model: 'gpt-5.3-codex',
    });
    store.applyToEnv();

    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.duckcoding.ai');
  });
});
