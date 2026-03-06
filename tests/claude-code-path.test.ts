import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isKnownInvalidClaudeCodePath,
  resolveClaudeCodeExecutablePath,
} from '../src/main/claude/claude-code-path';

function ensureFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/usr/bin/env node\n', 'utf-8');
}

describe('claude-code-path', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-claude-path-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects known invalid dist-electron main cli paths', () => {
    expect(isKnownInvalidClaudeCodePath('/tmp/project/dist-electron/main/cli.js')).toBe(true);
    expect(isKnownInvalidClaudeCodePath('C:\\project\\dist\\main\\cli.js')).toBe(true);
    expect(isKnownInvalidClaudeCodePath('/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe(false);
  });

  it('ignores invalid preferred path and falls back to env CLAUDE_CODE_PATH', () => {
    const invalidPreferred = path.join(tempDir, 'dist-electron', 'main', 'cli.js');
    const envPath = path.join(tempDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    ensureFile(invalidPreferred);
    ensureFile(envPath);

    const resolved = resolveClaudeCodeExecutablePath({
      preferredPath: invalidPreferred,
      env: {
        ...process.env,
        HOME: '',
        USERPROFILE: '',
        CLAUDE_CODE_PATH: envPath,
      },
    });

    expect(resolved).toEqual({
      executablePath: envPath,
      source: 'env.CLAUDE_CODE_PATH',
    });
  });

  it('ignores invalid env CLAUDE_CODE_PATH and keeps valid preferred path', () => {
    const preferredPath = path.join(tempDir, 'custom-claude');
    const invalidEnvPath = path.join(tempDir, 'dist', 'main', 'cli.js');
    ensureFile(preferredPath);
    ensureFile(invalidEnvPath);

    const resolved = resolveClaudeCodeExecutablePath({
      preferredPath,
      env: {
        ...process.env,
        HOME: '',
        USERPROFILE: '',
        CLAUDE_CODE_PATH: invalidEnvPath,
      },
    });

    expect(resolved).toEqual({
      executablePath: preferredPath,
      source: 'config.claudeCodePath',
    });
  });

  it('ignores env CLAUDE_CODE_PATH when it points to a directory', () => {
    const preferredPath = path.join(tempDir, 'preferred-claude');
    const envDir = path.join(tempDir, 'dir-path');
    ensureFile(preferredPath);
    fs.mkdirSync(envDir, { recursive: true });

    const resolved = resolveClaudeCodeExecutablePath({
      preferredPath,
      env: {
        ...process.env,
        HOME: '',
        USERPROFILE: '',
        CLAUDE_CODE_PATH: envDir,
      },
    });

    expect(resolved).toEqual({
      executablePath: preferredPath,
      source: 'config.claudeCodePath',
    });
  });
});
