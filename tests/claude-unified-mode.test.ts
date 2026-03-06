import { describe, expect, it } from 'vitest';
import { getClaudeUnifiedModeState, isClaudeUnifiedModeEnabled } from '../src/main/session/claude-unified-mode';

describe('claude unified mode', () => {
  it('enables unified mode by default', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(isClaudeUnifiedModeEnabled(env)).toBe(true);
    expect(getClaudeUnifiedModeState(env)).toEqual({
      enabled: true,
      reason: 'enabled-default',
      legacyForceFlag: false,
    });
  });

  it('disables unified mode when disable flag is set', () => {
    const env = { COWORK_DISABLE_CLAUDE_UNIFIED: '1' } as NodeJS.ProcessEnv;
    expect(isClaudeUnifiedModeEnabled(env)).toBe(false);
    expect(getClaudeUnifiedModeState(env)).toEqual({
      enabled: false,
      reason: 'disabled-by-env',
      legacyForceFlag: false,
    });
  });

  it('keeps unified mode enabled with legacy force flag for compatibility', () => {
    const env = { COWORK_FORCE_CLAUDE_AGENT_SDK: '1' } as NodeJS.ProcessEnv;
    expect(isClaudeUnifiedModeEnabled(env)).toBe(true);
    expect(getClaudeUnifiedModeState(env)).toEqual({
      enabled: true,
      reason: 'enabled-legacy-force',
      legacyForceFlag: true,
    });
  });
});
