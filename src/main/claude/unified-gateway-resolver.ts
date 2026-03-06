import { PROVIDER_PRESETS, type AppConfig } from '../config/config-store';
import {
  isOfficialOpenAIBaseUrl,
  normalizeAnthropicBaseUrl,
  normalizeOpenAICompatibleBaseUrl,
  OPENAI_PLATFORM_BASE_URL,
  resolveOpenAICredentials,
  shouldAllowEmptyOpenAIApiKey,
  shouldAllowEmptyAnthropicApiKey,
} from '../config/auth-utils';

const LOCAL_ANTHROPIC_PLACEHOLDER_KEY = 'sk-ant-local-proxy';
const LOCAL_OPENAI_PLACEHOLDER_KEY = 'sk-openai-local-proxy';
const UPSTREAM_PROVIDER_PREFIX_RE = /^(openai|anthropic|gemini|google|vertex|vertex_ai|bedrock|groq|cohere|mistral|azure|huggingface|ollama)\//i;
const LITELLM_PROVIDER_ALIAS_PREFIXES: Array<{ from: string; to: string }> = [
  { from: 'google/', to: 'gemini/' },
  { from: 'vertex/', to: 'vertex_ai/' },
];

export type UnifiedUpstreamKind = 'openai' | 'anthropic';

export interface UnifiedGatewayProfile {
  upstreamKind: UnifiedUpstreamKind;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  model: string;
  requiresProxy: true;
  provider: AppConfig['provider'];
  customProtocol: AppConfig['customProtocol'];
}

export interface ProxyRouteDecision {
  ok: boolean;
  reason: string;
  profile?: UnifiedGatewayProfile;
}

function normalizeOpenAIBaseUrl(baseUrl: string | undefined): string {
  return normalizeOpenAICompatibleBaseUrl(baseUrl) || OPENAI_PLATFORM_BASE_URL;
}

function resolveProviderBaseUrl(config: AppConfig): string | undefined {
  const customBase = config.baseUrl?.trim();
  if (customBase) {
    return customBase;
  }
  if (config.provider === 'custom') {
    return undefined;
  }
  return PROVIDER_PRESETS[config.provider]?.baseUrl;
}

function resolveModel(config: AppConfig): string {
  return config.model?.trim() || 'claude-sonnet-4-5';
}

function shouldUseLiteLLMProviderAliases(config: Pick<AppConfig, 'provider' | 'baseUrl'>): boolean {
  if (config.provider !== 'custom') {
    return false;
  }

  const normalizedBaseUrl = normalizeOpenAICompatibleBaseUrl(config.baseUrl)?.toLowerCase() || '';
  if (!normalizedBaseUrl) {
    return false;
  }
  if (normalizedBaseUrl.includes('openrouter.ai')) {
    return false;
  }
  if (isOfficialOpenAIBaseUrl(normalizedBaseUrl)) {
    return false;
  }
  return true;
}

function normalizeModelForUpstream(
  model: string,
  upstreamKind: UnifiedUpstreamKind,
  config: Pick<AppConfig, 'provider' | 'baseUrl'>
): string {
  let trimmed = model.trim();
  if (!trimmed) {
    return upstreamKind === 'openai' ? 'openai/gpt-4.1-mini' : 'claude-sonnet-4-5';
  }
  const lowered = trimmed.toLowerCase();
  const alias = shouldUseLiteLLMProviderAliases(config)
    ? LITELLM_PROVIDER_ALIAS_PREFIXES.find((item) => lowered.startsWith(item.from))
    : undefined;
  if (alias) {
    trimmed = `${alias.to}${trimmed.slice(alias.from.length)}`;
  }
  if (UPSTREAM_PROVIDER_PREFIX_RE.test(trimmed)) {
    return trimmed;
  }
  if (upstreamKind === 'openai') {
    return `openai/${trimmed}`;
  }
  return trimmed;
}

function resolveAnthropicProfile(config: AppConfig): ProxyRouteDecision {
  const rawBaseUrl = resolveProviderBaseUrl(config);
  if (config.provider === 'custom' && !rawBaseUrl) {
    return {
      ok: false,
      reason: 'missing_base_url',
    };
  }
  const upstreamBaseUrl = normalizeAnthropicBaseUrl(rawBaseUrl) || 'https://api.anthropic.com';
  const apiKey = config.apiKey?.trim() || (
    shouldAllowEmptyAnthropicApiKey(config)
      ? LOCAL_ANTHROPIC_PLACEHOLDER_KEY
      : ''
  );

  if (!apiKey) {
    return {
      ok: false,
      reason: 'missing_key',
    };
  }

  return {
    ok: true,
    reason: 'ok',
    profile: {
      upstreamKind: 'anthropic',
      upstreamBaseUrl,
      upstreamApiKey: apiKey,
      model: normalizeModelForUpstream(resolveModel(config), 'anthropic', config),
      requiresProxy: true,
      provider: config.provider,
      customProtocol: config.customProtocol,
    },
  };
}

function resolveOpenAIProfile(config: AppConfig): ProxyRouteDecision {
  const rawBaseUrl = resolveProviderBaseUrl(config);
  if (config.provider === 'custom' && !rawBaseUrl) {
    return {
      ok: false,
      reason: 'missing_base_url',
    };
  }

  const resolved = resolveOpenAICredentials(config, {
    allowLocalCodexFallback: config.provider === 'openai',
  });

  const candidateApiKey = resolved?.apiKey?.trim()
    || (shouldAllowEmptyOpenAIApiKey(config) ? LOCAL_OPENAI_PLACEHOLDER_KEY : '');
  if (!candidateApiKey) {
    return {
      ok: false,
      reason: 'missing_key',
    };
  }

  const upstreamBaseUrl = normalizeOpenAIBaseUrl(
    resolved?.baseUrl || rawBaseUrl
  );

  return {
    ok: true,
    reason: 'ok',
    profile: {
      upstreamKind: 'openai',
      upstreamBaseUrl,
      upstreamApiKey: candidateApiKey,
      model: normalizeModelForUpstream(resolveModel(config), 'openai', config),
      requiresProxy: true,
      provider: config.provider,
      customProtocol: config.customProtocol,
    },
  };
}

function resolveOpenRouterProfile(config: AppConfig): ProxyRouteDecision {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    return {
      ok: false,
      reason: 'missing_key',
    };
  }
  const upstreamBaseUrl = normalizeOpenAIBaseUrl(
    config.baseUrl?.trim() || PROVIDER_PRESETS.openrouter.baseUrl
  );
  return {
    ok: true,
    reason: 'ok',
    profile: {
      upstreamKind: 'openai',
      upstreamBaseUrl,
      upstreamApiKey: apiKey,
      model: normalizeModelForUpstream(resolveModel(config), 'openai', config),
      requiresProxy: true,
      provider: config.provider,
      customProtocol: 'openai',
    },
  };
}

export function resolveUnifiedGatewayProfile(config: AppConfig): ProxyRouteDecision {
  const customProtocol = config.provider === 'custom'
    ? (config.customProtocol === 'openai' ? 'openai' : 'anthropic')
    : 'anthropic';

  if (config.provider === 'openai' || (config.provider === 'custom' && customProtocol === 'openai')) {
    return resolveOpenAIProfile({ ...config, customProtocol });
  }

  if (config.provider === 'openrouter') {
    return resolveOpenRouterProfile(config);
  }

  return resolveAnthropicProfile({ ...config, customProtocol });
}
