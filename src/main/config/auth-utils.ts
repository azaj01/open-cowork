import type { AppConfig } from './config-store';
import { importLocalAuthToken } from '../auth/local-auth';
import { isLoopbackBaseUrl as sharedIsLoopbackBaseUrl } from '../../shared/network/loopback';

const API_KEY_PREFIX_RE = /^sk-/i;
const CHATGPT_ACCOUNT_ID_RE = /^[-_a-zA-Z0-9]{6,}$/;
const OFFICIAL_OPENAI_HOSTS = new Set(['api.openai.com', 'chatgpt.com']);

export const OPENAI_PLATFORM_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';

type OpenAIConfigLike = Pick<AppConfig, 'provider' | 'customProtocol' | 'apiKey' | 'baseUrl'>;

export interface ResolvedOpenAICredentials {
  apiKey: string;
  baseUrl?: string;
  accountId?: string;
  useCodexOAuth: boolean;
  source: 'apiKey' | 'localCodex';
}

export interface ResolveOpenAICredentialsOptions {
  allowLocalCodexFallback?: boolean;
}

export function isLikelyOAuthAccessToken(token: string | undefined | null): boolean {
  const value = token?.trim();
  if (!value) {
    return false;
  }
  return !API_KEY_PREFIX_RE.test(value);
}

export function shouldUseAnthropicAuthToken(config: Pick<AppConfig, 'provider' | 'customProtocol' | 'apiKey'>): boolean {
  if (config.provider === 'openrouter') {
    return true;
  }
  if (config.provider !== 'anthropic') {
    return false;
  }
  return isLikelyOAuthAccessToken(config.apiKey);
}

export function isOpenAIProvider(config: Pick<AppConfig, 'provider' | 'customProtocol'>): boolean {
  return config.provider === 'openai' || (config.provider === 'custom' && config.customProtocol === 'openai');
}

export function sanitizeOpenAIAccountId(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || value.includes('@')) {
    return undefined;
  }
  if (!CHATGPT_ACCOUNT_ID_RE.test(value)) {
    return undefined;
  }
  return value;
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const value = baseUrl?.trim();
  if (!value) {
    return undefined;
  }
  return value.replace(/\/+$/, '');
}

export function normalizeOpenAICompatibleBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes('openrouter.ai')) {
      return normalized;
    }

    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') {
      parsed.pathname = '/api/v1';
      return parsed.toString().replace(/\/+$/, '');
    }
    if (/^\/api$/i.test(pathname)) {
      parsed.pathname = '/api/v1';
      return parsed.toString().replace(/\/+$/, '');
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return normalized;
  }
}

function extractHostname(baseUrl: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isOfficialOpenAIBaseUrl(baseUrl: string | undefined): boolean {
  const host = extractHostname(baseUrl);
  if (!host) {
    return false;
  }
  if (OFFICIAL_OPENAI_HOSTS.has(host)) {
    return true;
  }
  for (const officialHost of OFFICIAL_OPENAI_HOSTS) {
    if (host.endsWith(`.${officialHost}`)) {
      return true;
    }
  }
  return false;
}

export function getUnifiedUnsupportedCustomOpenAIBaseUrl(
  config: OpenAIConfigLike
): string | null {
  if (!(config.provider === 'custom' && config.customProtocol === 'openai')) {
    return null;
  }
  const resolved = resolveOpenAICredentials(config);
  if (resolved?.useCodexOAuth) {
    return null;
  }
  const baseUrl = resolved?.baseUrl || config.baseUrl;
  if (!isOfficialOpenAIBaseUrl(baseUrl)) {
    return null;
  }
  return normalizeBaseUrl(baseUrl) || OPENAI_PLATFORM_BASE_URL;
}

export function normalizeAnthropicBaseUrl(baseUrl: string | undefined): string | undefined {
  const value = normalizeBaseUrl(baseUrl);
  if (!value) {
    return undefined;
  }
  if (/\/v1$/i.test(value)) {
    return value.slice(0, -3);
  }
  return value;
}

function shouldUseCodexOAuthForProvidedToken(config: OpenAIConfigLike, token: string): boolean {
  if (!isLikelyOAuthAccessToken(token)) {
    return false;
  }

  // OpenAI 官方 provider 下，非 sk- token 视为 Codex OAuth token
  if (config.provider === 'openai') {
    return true;
  }

  // 自定义 OpenAI 协议仅在明确使用 Codex backend 时按 OAuth 处理
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);
  return config.provider === 'custom'
    && config.customProtocol === 'openai'
    && normalizedBaseUrl === OPENAI_CODEX_BACKEND_BASE_URL;
}

export function resolveOpenAICredentials(
  config: OpenAIConfigLike,
  options: ResolveOpenAICredentialsOptions = {}
): ResolvedOpenAICredentials | null {
  const allowLocalCodexFallback = options.allowLocalCodexFallback !== false;
  const trimmedApiKey = config.apiKey?.trim();
  if (trimmedApiKey) {
    if (shouldUseCodexOAuthForProvidedToken(config, trimmedApiKey)) {
      const localCodex = importLocalAuthToken('codex');
      return {
        apiKey: trimmedApiKey,
        baseUrl: OPENAI_CODEX_BACKEND_BASE_URL,
        accountId: sanitizeOpenAIAccountId(localCodex?.account),
        useCodexOAuth: true,
        source: 'apiKey',
      };
    }

    return {
      apiKey: trimmedApiKey,
      baseUrl: normalizeOpenAICompatibleBaseUrl(config.baseUrl),
      useCodexOAuth: false,
      source: 'apiKey',
    };
  }

  if (!isOpenAIProvider(config)) {
    return null;
  }
  if (!allowLocalCodexFallback) {
    return null;
  }

  const localCodex = importLocalAuthToken('codex');
  const localToken = localCodex?.token?.trim();
  if (!localToken) {
    return null;
  }

  return {
    apiKey: localToken,
    baseUrl: OPENAI_CODEX_BACKEND_BASE_URL,
    accountId: sanitizeOpenAIAccountId(localCodex?.account),
    useCodexOAuth: true,
    source: 'localCodex',
  };
}

export function buildOpenAICodexHeaders(accountId?: string): Record<string, string> {
  return {
    'User-Agent': 'CodexBar',
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  };
}

export function isLoopbackBaseUrl(baseUrl: string | undefined): boolean {
  return sharedIsLoopbackBaseUrl(baseUrl);
}

export function shouldAllowEmptyAnthropicApiKey(
  config: Pick<AppConfig, 'provider' | 'customProtocol' | 'baseUrl'>
): boolean {
  return config.provider === 'custom'
    && (config.customProtocol ?? 'anthropic') === 'anthropic'
    && isLoopbackBaseUrl(config.baseUrl);
}

export function shouldAllowEmptyOpenAIApiKey(
  config: Pick<AppConfig, 'provider' | 'customProtocol' | 'baseUrl'>
): boolean {
  return config.provider === 'custom'
    && (config.customProtocol ?? 'anthropic') === 'openai'
    && isLoopbackBaseUrl(config.baseUrl);
}

export function shouldAllowEmptyGeminiApiKey(
  config: Pick<AppConfig, 'provider' | 'customProtocol' | 'baseUrl'>
): boolean {
  return config.provider === 'custom'
    && (config.customProtocol ?? 'anthropic') === 'gemini'
    && isLoopbackBaseUrl(config.baseUrl);
}
