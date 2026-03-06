import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('config warmup guard', () => {
  it('runs proxy warmup in background during startup and config mutations', () => {
    const source = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf-8');

    expect(source).toContain("void claudeProxyManager.warmupForConfig(configStore.getAll())");
    expect(source).not.toContain("await claudeProxyManager.warmupForConfig(configStore.getAll())");
  });
});
