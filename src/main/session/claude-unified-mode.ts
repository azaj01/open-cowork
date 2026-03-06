export type ClaudeUnifiedModeReason =
  | 'disabled-by-env'
  | 'enabled-default'
  | 'enabled-legacy-force';

export interface ClaudeUnifiedModeState {
  enabled: boolean;
  reason: ClaudeUnifiedModeReason;
  legacyForceFlag: boolean;
}

export function getClaudeUnifiedModeState(
  env: NodeJS.ProcessEnv = process.env
): ClaudeUnifiedModeState {
  const legacyForceFlag = env.COWORK_FORCE_CLAUDE_AGENT_SDK === '1';
  if (env.COWORK_DISABLE_CLAUDE_UNIFIED === '1') {
    return {
      enabled: false,
      reason: 'disabled-by-env',
      legacyForceFlag,
    };
  }
  if (legacyForceFlag) {
    return {
      enabled: true,
      reason: 'enabled-legacy-force',
      legacyForceFlag,
    };
  }
  return {
    enabled: true,
    reason: 'enabled-default',
    legacyForceFlag: false,
  };
}

export function isClaudeUnifiedModeEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return getClaudeUnifiedModeState(env).enabled;
}
