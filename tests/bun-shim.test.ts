import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isNodeExecutable, withBunHashShimEnv, withBunHashShimNodeArgs } from '../src/main/claude/bun-shim';

describe('withBunHashShimEnv', () => {
  it('appends bun hash shim require flag when absent', () => {
    const result = withBunHashShimEnv({});
    expect(result.NODE_OPTIONS).toContain('--require=');
    expect(result.NODE_OPTIONS).toContain('bun-hash-shim.cjs');
  });

  it('does not duplicate require flag when already present', () => {
    const once = withBunHashShimEnv({});
    const twice = withBunHashShimEnv(once);
    expect(twice.NODE_OPTIONS).toBe(once.NODE_OPTIONS);
  });

  it('prepends --require for node invocation args', () => {
    const next = withBunHashShimNodeArgs(['/tmp/cli.js', '--output-format', 'stream-json']);
    expect(next[0]).toBe('--require');
    expect(next[1]).toContain('bun-hash-shim.cjs');
    expect(next[2]).toBe('/tmp/cli.js');
  });

  it('provides Bun compatibility helpers needed by Claude Code under Node', () => {
    const args = withBunHashShimNodeArgs(['-e', `
      console.log(JSON.stringify({
        hash: typeof Bun.hash,
        which: typeof Bun.which,
        stringWidth: typeof Bun.stringWidth,
        embeddedFiles: Array.isArray(Bun.embeddedFiles),
        width: Bun.stringWidth('hello')
      }));
    `]);
    const output = execFileSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();

    expect(JSON.parse(output)).toEqual({
      hash: 'function',
      which: 'function',
      stringWidth: 'function',
      embeddedFiles: true,
      width: 5,
    });
  });

  it('keeps Claude Code CLI startup working when shim is injected', () => {
    const args = withBunHashShimNodeArgs([
      'node_modules/@anthropic-ai/claude-code/cli.js',
      '--help',
    ]);
    const output = execFileSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('Usage: claude');
  });

  it('detects node executable names', () => {
    expect(isNodeExecutable('node')).toBe(true);
    expect(isNodeExecutable('/usr/local/bin/node')).toBe(true);
    expect(isNodeExecutable('/opt/homebrew/bin/node')).toBe(true);
    expect(isNodeExecutable('python')).toBe(false);
  });
});
