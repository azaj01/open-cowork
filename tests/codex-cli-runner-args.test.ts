import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const runnerPath = path.resolve(process.cwd(), 'src/main/openai/codex-cli-runner.ts');

describe('codex cli args assembly', () => {
  it('enables ephemeral mode for fresh sessions', () => {
    const source = fs.readFileSync(runnerPath, 'utf8');
    expect(source).toContain("args.push('--json', '--skip-git-repo-check', '--ephemeral', '-C', params.cwd);");
  });

  it('keeps resume branch explicit without ephemeral flag', () => {
    const source = fs.readFileSync(runnerPath, 'utf8');
    expect(source).toContain("args.push('resume', '--json', '--skip-git-repo-check');");
  });
});
