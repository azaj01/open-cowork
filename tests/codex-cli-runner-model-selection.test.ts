import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/mcp/codex-mcp-overrides', () => ({
  buildCodexMcpOverrides: () => [],
}));

import { resolveCodexRunModel } from '../src/main/openai/codex-cli-runner';

describe('resolveCodexRunModel', () => {
  it('prefers OPENAI_MODEL when valid', () => {
    expect(resolveCodexRunModel('claude-sonnet-4-5', 'gpt-5.3-codex')).toBe('gpt-5.3-codex');
  });

  it('falls back to configured model when env model is invalid', () => {
    expect(resolveCodexRunModel('gpt-5.2', 'claude-sonnet-4-5')).toBe('gpt-5.2');
  });

  it('uses default codex model when both candidates are invalid', () => {
    expect(resolveCodexRunModel('anthropic/claude-sonnet-4.5', 'gemini-2.0-flash')).toBe(
      'gpt-5.2-codex'
    );
  });
});
