import { describe, expect, it } from 'vitest';
import {
  getClaudeUnifiedModeState,
  isClaudeUnifiedModeEnabled,
  requiresUnifiedClaudeSdk,
  requiresUnifiedClaudeProxy,
  shouldUseUnifiedClaudeSdk,
  shouldUseUnifiedClaudeProxy,
} from '../src/main/session/claude-unified-mode';

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

  it('marks gemini providers as requiring unified sdk routing', () => {
    expect(requiresUnifiedClaudeSdk({ provider: 'gemini', customProtocol: 'gemini' })).toBe(true);
    expect(requiresUnifiedClaudeSdk({ provider: 'custom', customProtocol: 'gemini' })).toBe(true);
    expect(requiresUnifiedClaudeSdk({ provider: 'openai', customProtocol: 'openai' })).toBe(false);
  });

  it('marks only non-anthropic profiles as requiring proxy', () => {
    expect(requiresUnifiedClaudeProxy({ provider: 'anthropic', customProtocol: 'anthropic' })).toBe(false);
    expect(requiresUnifiedClaudeProxy({ provider: 'custom', customProtocol: 'anthropic' })).toBe(false);
    expect(requiresUnifiedClaudeProxy({ provider: 'openai', customProtocol: 'openai' })).toBe(true);
    expect(requiresUnifiedClaudeProxy({ provider: 'custom', customProtocol: 'openai' })).toBe(true);
    expect(requiresUnifiedClaudeProxy({ provider: 'openrouter', customProtocol: 'anthropic' })).toBe(true);
  });

  it('keeps gemini profiles on unified sdk/proxy path even when legacy flags are set', () => {
    const env = {
      COWORK_DISABLE_CLAUDE_UNIFIED: '1',
      COWORK_DISABLE_CLAUDE_PROXY: '1',
    } as NodeJS.ProcessEnv;

    expect(shouldUseUnifiedClaudeSdk({ provider: 'gemini', customProtocol: 'gemini' }, env)).toBe(true);
    expect(shouldUseUnifiedClaudeProxy({ provider: 'gemini', customProtocol: 'gemini' }, env)).toBe(true);
  });

  it('keeps custom anthropic on unified sdk path without proxy', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(shouldUseUnifiedClaudeSdk({ provider: 'custom', customProtocol: 'anthropic' }, env)).toBe(true);
    expect(shouldUseUnifiedClaudeProxy({ provider: 'custom', customProtocol: 'anthropic' }, env)).toBe(false);
  });

  it('falls back to legacy openai path when proxy is explicitly disabled', () => {
    const env = {
      COWORK_DISABLE_CLAUDE_PROXY: '1',
    } as NodeJS.ProcessEnv;

    expect(shouldUseUnifiedClaudeSdk({ provider: 'openai', customProtocol: 'openai' }, env)).toBe(false);
    expect(shouldUseUnifiedClaudeProxy({ provider: 'openai', customProtocol: 'openai' }, env)).toBe(false);
  });
});
