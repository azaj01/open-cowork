import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logWarn } from '../utils/logger';

const BUN_HASH_SHIM_SOURCE = `'use strict';
(function initBunHashShim() {
  const globalObj = globalThis;
  const existingBun = typeof globalObj.Bun === 'object' && globalObj.Bun !== null
    ? globalObj.Bun
    : null;
  const hasCompatibleBun = existingBun
    && typeof existingBun.hash === 'function'
    && typeof existingBun.which === 'function'
    && typeof existingBun.stringWidth === 'function';
  if (hasCompatibleBun) return;

  const crypto = require('node:crypto');
  const { execFileSync } = require('node:child_process');
  const hash = (value) => {
    const normalized = typeof value === 'string' ? value : JSON.stringify(value);
    const digest = crypto.createHash('sha256').update(String(normalized)).digest();
    let out = 0n;
    for (let i = 0; i < 8; i += 1) {
      out = (out << 8n) + BigInt(digest[i]);
    }
    return out;
  };
  const which = (binary) => {
    if (!binary) return null;
    const command = String(binary);
    if (process.platform === 'win32') {
      try {
        const output = execFileSync('where.exe', [command], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return output.split(/\\r?\\n/)[0] || null;
      } catch {
        return null;
      }
    }

    try {
      const output = execFileSync('which', [command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return output || null;
    } catch {
      return null;
    }
  };
  const stringWidth = (value) => {
    const text = String(value ?? '').replace(/\\u001B\\[[0-9;]*m/g, '');
    return Array.from(text).length;
  };

  const compatBun = existingBun || {};
  if (typeof compatBun.hash !== 'function') compatBun.hash = hash;
  if (typeof compatBun.which !== 'function') compatBun.which = which;
  if (typeof compatBun.stringWidth !== 'function') compatBun.stringWidth = stringWidth;
  if (!Array.isArray(compatBun.embeddedFiles)) compatBun.embeddedFiles = [];
  globalObj.Bun = compatBun;
})();
`;

let cachedShimPath: string | null = null;

function ensureBunHashShimPath(): string | null {
  if (cachedShimPath && existsSync(cachedShimPath)) {
    return cachedShimPath;
  }

  const dirPath = path.join(os.tmpdir(), 'open-cowork');
  const filePath = path.join(dirPath, 'bun-hash-shim.cjs');

  try {
    mkdirSync(dirPath, { recursive: true });
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
    if (existing !== BUN_HASH_SHIM_SOURCE) {
      writeFileSync(filePath, BUN_HASH_SHIM_SOURCE, 'utf-8');
    }
    cachedShimPath = filePath;
    return filePath;
  } catch (error) {
    logWarn('[ClaudeAgentRunner] Failed to prepare Bun hash shim', error);
    return null;
  }
}

export function withBunHashShimEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shimPath = ensureBunHashShimPath();
  if (!shimPath) {
    return env;
  }

  const requireFlag = `--require=${shimPath}`;
  const existingNodeOptions = (env.NODE_OPTIONS || '').trim();
  if (existingNodeOptions.includes(requireFlag)) {
    return env;
  }

  return {
    ...env,
    NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${requireFlag}` : requireFlag,
  };
}

function hasRequireFlag(args: string[], shimPath: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i] || '';
    if (current === '--require' && args[i + 1] === shimPath) {
      return true;
    }
    if (current === `--require=${shimPath}`) {
      return true;
    }
  }
  return false;
}

export function withBunHashShimNodeArgs(args: string[]): string[] {
  const shimPath = ensureBunHashShimPath();
  if (!shimPath) {
    return args;
  }
  if (hasRequireFlag(args, shimPath)) {
    return args;
  }
  return ['--require', shimPath, ...args];
}

export function isNodeExecutable(command: string): boolean {
  const basename = path.basename(command || '').toLowerCase();
  return basename === 'node' || basename === 'node.exe';
}
