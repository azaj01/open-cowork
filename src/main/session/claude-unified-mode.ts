import type { AppConfig } from '../config/config-store';

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

export function requiresUnifiedClaudeSdk(
  config: Pick<AppConfig, 'provider' | 'customProtocol'>
): boolean {
  return config.provider === 'gemini'
    || (config.provider === 'custom' && config.customProtocol === 'gemini');
}

export function requiresUnifiedClaudeProxy(
  config: Pick<AppConfig, 'provider' | 'customProtocol'>
): boolean {
  return config.provider === 'openrouter'
    || config.provider === 'openai'
    || config.provider === 'gemini'
    || (config.provider === 'custom' && (
      config.customProtocol === 'openai'
      || config.customProtocol === 'gemini'
    ));
}

export function shouldUseUnifiedClaudeSdk(
  config: Pick<AppConfig, 'provider' | 'customProtocol'>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (requiresUnifiedClaudeSdk(config)) {
    return true;
  }
  if (!isClaudeUnifiedModeEnabled(env)) {
    return false;
  }
  if (env.COWORK_DISABLE_CLAUDE_PROXY === '1' && requiresUnifiedClaudeProxy(config)) {
    return false;
  }
  return true;
}

export function shouldUseUnifiedClaudeProxy(
  config: Pick<AppConfig, 'provider' | 'customProtocol'>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!shouldUseUnifiedClaudeSdk(config, env)) {
    return false;
  }
  if (env.COWORK_DISABLE_CLAUDE_PROXY === '1') {
    return requiresUnifiedClaudeSdk(config);
  }
  return requiresUnifiedClaudeProxy(config);
}
