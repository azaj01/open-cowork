import type { AppConfig } from '../config/config-store';
import {
  isLoopbackBaseUrl,
  isOfficialOpenAIBaseUrl,
  normalizeAnthropicBaseUrl,
  normalizeOpenAICompatibleBaseUrl,
  resolveOpenAICredentials,
  shouldAllowEmptyOpenAIApiKey,
  shouldAllowEmptyAnthropicApiKey,
  shouldUseAnthropicAuthToken,
} from '../config/auth-utils';

const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_MODE',
  'OPENAI_ACCOUNT_ID',
  'OPENAI_CODEX_OAUTH',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'CLAUDE_CODE_PATH',
];
const LOCAL_OPENAI_PLACEHOLDER_KEY = 'sk-openai-local-proxy';

export interface ClaudeEnvOverridesOptions {
  proxyBaseUrl?: string;
  proxyApiKey?: string;
}

export function getClaudeEnvOverrides(
  config: AppConfig,
  options: ClaudeEnvOverridesOptions = {}
): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {};
  const proxyBaseUrl = options.proxyBaseUrl?.trim();

  if (proxyBaseUrl) {
    if (config.model) {
      overrides.CLAUDE_MODEL = config.model;
      overrides.ANTHROPIC_DEFAULT_SONNET_MODEL = config.model;
    }
    overrides.ANTHROPIC_BASE_URL = proxyBaseUrl.replace(/\/+$/, '');
    overrides.ANTHROPIC_API_KEY = options.proxyApiKey?.trim() || 'sk-ant-local-proxy';
    overrides.ANTHROPIC_AUTH_TOKEN = '';
    return overrides;
  }

  const useOpenAI =
    config.provider === 'openai' ||
    (config.provider === 'custom' && config.customProtocol === 'openai');
  const trimmedApiKey = config.apiKey?.trim() || '';
  const fallbackAnthropicApiKey = shouldAllowEmptyAnthropicApiKey(config)
    ? 'sk-ant-local-proxy'
    : '';
  const resolvedAnthropicApiKey = trimmedApiKey || fallbackAnthropicApiKey;

  if (config.model) {
    overrides.CLAUDE_MODEL = config.model;
  }

  if (useOpenAI) {
    const resolvedOpenAI = resolveOpenAICredentials({
      provider: config.provider,
      customProtocol: config.customProtocol,
      apiKey: trimmedApiKey,
      baseUrl: config.baseUrl,
    }, {
      // 仅 OpenAI 原生 provider 允许使用本地 Codex OAuth 作为自动回退。
      // custom/openai 与 openrouter 必须尊重用户当前网关配置，避免漂移到 chatgpt backend。
      allowLocalCodexFallback: config.provider === 'openai',
    });
    const fallbackOpenAIKey = shouldAllowEmptyOpenAIApiKey(config)
      ? LOCAL_OPENAI_PLACEHOLDER_KEY
      : '';
    const resolvedOpenAIKey = resolvedOpenAI?.apiKey || fallbackOpenAIKey;
    if (resolvedOpenAIKey) {
      overrides.OPENAI_API_KEY = resolvedOpenAIKey;
    }
    const resolvedBaseUrl = normalizeOpenAICompatibleBaseUrl(
      resolvedOpenAI?.baseUrl || config.baseUrl
    );
    if (resolvedBaseUrl) {
      overrides.OPENAI_BASE_URL = resolvedBaseUrl;
    }
    if (config.openaiMode) overrides.OPENAI_API_MODE = config.openaiMode;
    if (config.model) overrides.OPENAI_MODEL = config.model;
    if (resolvedOpenAI?.accountId) {
      overrides.OPENAI_ACCOUNT_ID = resolvedOpenAI.accountId;
    }
    overrides.OPENAI_CODEX_OAUTH = resolvedOpenAI?.useCodexOAuth ? '1' : '0';

    // Claude Code 2.1.x 在 SDK 路径下不会读取 OPENAI_* 作为主认证来源（apiKeySource 会是 none）。
    // 对 custom+openai 兼容层：将同一凭证镜像到 ANTHROPIC_*，让统一链路可直接工作。
    const shouldMirrorToAnthropic =
      config.provider === 'custom'
      && config.customProtocol === 'openai'
      && !isOfficialOpenAIBaseUrl(resolvedBaseUrl)
      && process.env.COWORK_DISABLE_OPENAI_MIRROR !== '1';
    if (shouldMirrorToAnthropic && resolvedOpenAIKey) {
      overrides.ANTHROPIC_API_KEY = resolvedOpenAIKey;
      const mirroredBaseUrl = normalizeAnthropicBaseUrl(resolvedBaseUrl);
      if (mirroredBaseUrl) {
        overrides.ANTHROPIC_BASE_URL = mirroredBaseUrl;
      } else if (isLoopbackBaseUrl(resolvedBaseUrl)) {
        // loopback custom provider 允许空 baseUrl 透传，但仍保留 key 镜像。
        delete overrides.ANTHROPIC_BASE_URL;
      }
      if (config.model) {
        overrides.ANTHROPIC_DEFAULT_SONNET_MODEL = config.model;
      }
    }

    return overrides;
  }

  if (resolvedAnthropicApiKey) {
    if (
      config.provider === 'openrouter' ||
      shouldUseAnthropicAuthToken({ ...config, apiKey: resolvedAnthropicApiKey })
    ) {
      overrides.ANTHROPIC_AUTH_TOKEN = resolvedAnthropicApiKey;
      if (config.provider === 'openrouter') {
        // OpenRouter proxy mode requires ANTHROPIC_API_KEY to stay empty.
        overrides.ANTHROPIC_API_KEY = '';
      }
    } else {
      overrides.ANTHROPIC_API_KEY = resolvedAnthropicApiKey;
    }
  }
  const normalizedAnthropicBaseUrl = normalizeAnthropicBaseUrl(config.baseUrl);
  if (normalizedAnthropicBaseUrl) overrides.ANTHROPIC_BASE_URL = normalizedAnthropicBaseUrl;
  if (config.model) overrides.ANTHROPIC_DEFAULT_SONNET_MODEL = config.model;

  return overrides;
}

export function buildClaudeEnv(
  shellEnv: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const sanitizedShellEnv: NodeJS.ProcessEnv = { ...shellEnv };
  for (const key of CLAUDE_ENV_KEYS) {
    delete sanitizedShellEnv[key];
  }
  return {
    ...sanitizedShellEnv,
    ...overrides,
  };
}
