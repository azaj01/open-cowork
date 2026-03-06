import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { app } from 'electron';
import type { ApiTestInput, ApiTestResult } from '../../renderer/types';
import { PROVIDER_PRESETS, type AppConfig, type CustomProtocolType } from '../config/config-store';
import {
  normalizeAnthropicBaseUrl,
} from '../config/auth-utils';
import { buildClaudeEnv, getClaudeEnvOverrides } from './claude-env';
import { logWarn } from '../utils/logger';
import { resolveClaudeCodeExecutablePath } from './claude-code-path';
import { normalizeGeneratedTitle } from '../session/session-title-utils';
import { resolveUnifiedGatewayProfile } from './unified-gateway-resolver';
import { claudeProxyManager } from '../proxy/claude-proxy-manager';
import { shouldUseUnifiedClaudeProxy } from '../session/claude-unified-mode';
import { isNodeExecutable, withBunHashShimEnv, withBunHashShimNodeArgs } from './bun-shim';
import { isSyntheticAssistantTextBlock } from './assistant-text-filter';

const NETWORK_ERROR_RE = /enotfound|econnrefused|etimedout|eai_again|enetunreach|timed?\s*out|timeout|abort|network\s*error/i;
const AUTH_ERROR_RE = /authentication[_\s-]?failed|unauthorized|invalid[_\s-]?api[_\s-]?key|forbidden|401|403/i;
const RATE_LIMIT_RE = /rate[_\s-]?limit|too\s+many\s+requests|429/i;
const SERVER_ERROR_RE = /server[_\s-]?error|internal\s+server\s+error|5\d\d/i;
const LOGIN_REQUIRED_RE = /run\s+\/login|please\s+run\s+\/login/i;
const PROBE_ACK = 'sdk_probe_ok';

interface ClaudeOneShotResult {
  text: string;
  errors: string[];
  durationMs: number;
}

function stringifyDiagnosticValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value == null) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushDiagnostic(errors: string[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      pushDiagnostic(errors, entry);
    }
    return;
  }

  const text = stringifyDiagnosticValue(value);
  if (!text) {
    return;
  }
  if (!errors.includes(text)) {
    errors.push(text);
  }
}

function mapRouteReasonToProxyError(reason: string | undefined): string {
  if (reason === 'missing_key') {
    return 'proxy_upstream_auth_failed:missing_key';
  }
  if (reason === 'missing_base_url') {
    return 'proxy_upstream_not_found:missing_base_url';
  }
  return `proxy_upstream_not_found:${reason || 'unknown'}`;
}

function resolveOneShotClaudeConfigDir(): string {
  const explicit = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    if (typeof app?.getPath === 'function') {
      return path.join(app.getPath('userData'), 'claude');
    }
  } catch {
    // 非 Electron 场景（如单测）走临时目录兜底，避免读到用户全局 ~/.claude 登录态。
  }

  return path.join(os.tmpdir(), 'open-cowork', 'claude');
}

function readOptionalStringField(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') {
    return null;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function resolveProbeBaseUrl(input: ApiTestInput): string | undefined {
  const configured = input.baseUrl?.trim();
  if (configured) {
    return configured;
  }
  if (input.provider !== 'custom') {
    return PROVIDER_PRESETS[input.provider]?.baseUrl;
  }
  return undefined;
}

function resolveCustomProtocol(provider: AppConfig['provider'], customProtocol?: CustomProtocolType): CustomProtocolType {
  if (provider === 'custom') {
    if (customProtocol === 'openai' || customProtocol === 'gemini') {
      return customProtocol;
    }
    return 'anthropic';
  }
  if (provider === 'openai') {
    return 'openai';
  }
  if (provider === 'gemini') {
    return 'gemini';
  }
  return 'anthropic';
}

function buildProbeConfig(input: ApiTestInput, config: AppConfig): AppConfig {
  const resolvedBaseUrl = resolveProbeBaseUrl(input);
  const normalizedInputApiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined;
  const effectiveApiKey = normalizedInputApiKey || config.apiKey?.trim() || '';
  const resolvedCustomProtocol = resolveCustomProtocol(input.provider, input.customProtocol);
  const effectiveRawBaseUrl = input.provider === 'custom' ? resolvedBaseUrl || '' : resolvedBaseUrl || config.baseUrl;
  const effectiveBaseUrl = resolvedCustomProtocol === 'openai' || resolvedCustomProtocol === 'gemini'
    ? effectiveRawBaseUrl
    : normalizeAnthropicBaseUrl(effectiveRawBaseUrl);
  return {
    ...config,
    provider: input.provider,
    customProtocol: resolvedCustomProtocol,
    apiKey: effectiveApiKey,
    baseUrl: input.provider === 'custom' ? effectiveBaseUrl || '' : effectiveBaseUrl || config.baseUrl,
    model: input.model?.trim() || config.model,
    openaiMode: config.openaiMode === 'chat' ? 'chat' : 'responses',
  };
}

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') {
    return '';
  }
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const typedBlock = block as { type?: string; text?: string };
    if ((typedBlock.type === 'text' || typedBlock.type === 'output_text') && typeof typedBlock.text === 'string') {
      if (isSyntheticAssistantTextBlock(typedBlock.text)) {
        continue;
      }
      parts.push(typedBlock.text);
    }
  }
  return parts.join('').trim();
}

function mapClaudeSdkError(errorText: string, durationMs: number): ApiTestResult {
  const details = errorText.trim();
  const lowered = details.toLowerCase();

  if (lowered.includes('proxy_boot_failed')) {
    return { ok: false, latencyMs: durationMs, errorType: 'proxy_boot_failed', details };
  }
  if (lowered.includes('proxy_health_failed')) {
    return { ok: false, latencyMs: durationMs, errorType: 'proxy_health_failed', details };
  }
  if (lowered.includes('proxy_upstream_auth_failed')) {
    return { ok: false, latencyMs: durationMs, errorType: 'proxy_upstream_auth_failed', details };
  }
  if (lowered.includes('proxy_upstream_not_found')) {
    return { ok: false, latencyMs: durationMs, errorType: 'proxy_upstream_not_found', details };
  }
  if (lowered.includes('llm provider not provided')) {
    return { ok: false, latencyMs: durationMs, errorType: 'proxy_upstream_not_found', details };
  }
  if (AUTH_ERROR_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'unauthorized', details };
  }
  if (LOGIN_REQUIRED_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'unauthorized', details };
  }
  if (RATE_LIMIT_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'rate_limited', details };
  }
  if (SERVER_ERROR_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'server_error', details };
  }
  if (NETWORK_ERROR_RE.test(lowered)) {
    return { ok: false, latencyMs: durationMs, errorType: 'network_error', details };
  }
  return { ok: false, latencyMs: durationMs, errorType: 'unknown', details };
}

function resolveOneShotCwd(config: AppConfig, cwdOverride?: string): string {
  const requested = cwdOverride?.trim();
  if (requested && existsSync(requested)) {
    return requested;
  }
  const configured = config.defaultWorkdir?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }
  return process.cwd();
}

type OneShotSpawnOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

function resolveBundledNodePath(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  let resourcesPath: string;
  if (process.env.NODE_ENV === 'development') {
    const projectRoot = path.join(__dirname, '..', '..', '..');
    resourcesPath = path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`);
  } else {
    resourcesPath = path.join(process.resourcesPath, 'node');
  }

  const binDir = platform === 'win32' ? resourcesPath : path.join(resourcesPath, 'bin');
  const nodeExe = platform === 'win32' ? 'node.exe' : 'node';
  const bundledNodePath = path.join(binDir, nodeExe);
  return existsSync(bundledNodePath) ? bundledNodePath : null;
}

function createOneShotSpawnOverride(
  runtimeEnv: NodeJS.ProcessEnv,
  onStderr?: (data: string) => void,
) {
  return (spawnOptions: OneShotSpawnOptions): ChildProcess => {
    const { command, args, cwd, env, signal } = spawnOptions;
    const mergedEnv: NodeJS.ProcessEnv = {
      ...runtimeEnv,
      ...(env || {}),
    };
    const actualEnv = withBunHashShimEnv(mergedEnv);
    const argsWithShim = isNodeExecutable(command) ? withBunHashShimNodeArgs(args) : args;

    if (command === 'node') {
      const bundledNode = resolveBundledNodePath();
      if (bundledNode) {
        const child = spawn(bundledNode, argsWithShim, {
          cwd,
          env: actualEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal,
        });
        child.stderr?.on('data', (data) => {
          const message = data.toString();
          if (onStderr) {
            onStderr(message);
          }
        });
        return child;
      }
    }

    const child = spawn(command, argsWithShim, {
      cwd,
      env: actualEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    });
    child.stderr?.on('data', (data) => {
      const message = data.toString();
      if (onStderr) {
        onStderr(message);
      }
    });
    return child;
  };
}

async function runClaudeOneShot(
  prompt: string,
  config: AppConfig,
  systemPrompt: string,
  cwdOverride?: string
): Promise<ClaudeOneShotResult> {
  let effectiveConfig = config;
  let overrides = getClaudeEnvOverrides(effectiveConfig);
  let proxyLeaseSignature: string | null = null;
  if (shouldUseUnifiedClaudeProxy(config)) {
    const route = resolveUnifiedGatewayProfile(config);
    if (!route.ok || !route.profile) {
      return {
        text: '',
        errors: [mapRouteReasonToProxyError(route.reason)],
        durationMs: 0,
      };
    }

    try {
      const runtime = await claudeProxyManager.ensureReady(route.profile);
      claudeProxyManager.retain(runtime.signature);
      proxyLeaseSignature = runtime.signature;
      effectiveConfig = {
        ...config,
        model: route.profile.model,
      };
      overrides = getClaudeEnvOverrides(effectiveConfig, {
        proxyBaseUrl: runtime.baseUrl,
        proxyApiKey: runtime.sdkApiKey,
      });
    } catch (error) {
      return {
        text: '',
        errors: [error instanceof Error ? error.message : String(error)],
        durationMs: 0,
      };
    }
  }
  const claudeConfigDir = resolveOneShotClaudeConfigDir();
  const env = {
    ...buildClaudeEnv(process.env, overrides),
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
  try {
    mkdirSync(claudeConfigDir, { recursive: true });
  } catch {
    // 目录创建失败不阻断调用，SDK 将在后续返回可诊断错误。
  }
  const resolvedClaudeCode = resolveClaudeCodeExecutablePath({
    preferredPath: config.claudeCodePath,
    env,
  });
  if (!resolvedClaudeCode?.executablePath) {
    return {
      text: '',
      errors: [
        'Claude Code executable not found. Please install @anthropic-ai/claude-code or configure claudeCodePath.',
      ],
      durationMs: 0,
    };
  }

  const errors: string[] = [];
  const recordClaudeStderr = (data: string) => {
    const trimmed = data.trim();
    if (!trimmed) {
      return;
    }
    logWarn('[claude-sdk-one-shot][stderr]', trimmed);
    pushDiagnostic(errors, trimmed);
  };

  const queryOptions: any = {
    cwd: resolveOneShotCwd(effectiveConfig, cwdOverride),
    model: effectiveConfig.model || undefined,
    maxTurns: 2,
    persistSession: false,
    tools: [],
    permissionMode: 'default',
    env,
    pathToClaudeCodeExecutable: resolvedClaudeCode.executablePath,
    systemPrompt,
    stderr: recordClaudeStderr,
    spawnClaudeCodeProcess: createOneShotSpawnOverride(env, recordClaudeStderr),
  };

  const start = Date.now();
  let text = '';

  try {
    for await (const message of query({ prompt, options: queryOptions })) {
      if (message.type === 'assistant') {
        const assistantText = extractAssistantText(message);
        if (assistantText) {
          text = assistantText;
        }
        if (typeof message.error === 'string' && message.error.trim()) {
          pushDiagnostic(errors, message.error);
        }
        continue;
      }
      if (message.type !== 'result') {
        continue;
      }

      if (message.subtype !== 'success') {
        const resultErrors = Array.isArray(message.errors) ? message.errors : [];
        pushDiagnostic(errors, resultErrors);
        pushDiagnostic(errors, readOptionalStringField(message, 'result'));
        pushDiagnostic(errors, readOptionalStringField(message, 'error'));
        if (errors.length === 0) {
          pushDiagnostic(errors, message);
        }
        continue;
      }

      if (message.is_error) {
        pushDiagnostic(errors, (message as { errors?: unknown }).errors);
        pushDiagnostic(errors, message.result);
        pushDiagnostic(errors, readOptionalStringField(message, 'error'));
        if (errors.length === 0) {
          pushDiagnostic(errors, {
            subtype: message.subtype,
            is_error: message.is_error,
          });
        }
        continue;
      }

      if (!text && typeof message.result === 'string' && message.result.trim()) {
        text = message.result.trim();
      }
    }
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    if (details && !errors.some((entry) => entry === details)) {
      errors.push(details);
    }
  } finally {
    if (proxyLeaseSignature) {
      await claudeProxyManager.release(proxyLeaseSignature);
    }
  }

  return {
    text,
    errors,
    durationMs: Date.now() - start,
  };
}

function normalizeProbeAck(raw: string): string {
  return raw.replace(/^["'`]+|["'`]+$/g, '').trim().toLowerCase();
}

function hasUsableProbeCredentials(config: AppConfig): { ok: true } | { ok: false; details?: string } {
  const route = resolveUnifiedGatewayProfile(config);
  if (!route.ok || !route.profile) {
    if (route.reason === 'missing_key') {
      if (config.provider === 'openrouter') {
        return {
          ok: false,
          details: 'OpenRouter key is required for this profile.',
        };
      }
      if (config.provider === 'openai') {
        return {
          ok: false,
          details: 'OpenAI key is required, or run: codex auth login',
        };
      }
      return {
        ok: false,
        details: 'API key is required for the current provider/profile.',
      };
    }
    if (route.reason === 'missing_base_url') {
      return {
        ok: false,
        details: 'Base URL is required for custom provider.',
      };
    }
    return { ok: false, details: route.reason || 'unresolved_route' };
  }
  return route.profile.upstreamApiKey?.trim()
    ? { ok: true }
    : { ok: false };
}

export async function probeWithClaudeSdk(input: ApiTestInput, config: AppConfig): Promise<ApiTestResult> {
  const probeConfig = buildProbeConfig(input, config);
  if (input.provider === 'custom' && !probeConfig.baseUrl?.trim()) {
    return { ok: false, errorType: 'missing_base_url' };
  }

  if (!probeConfig.model?.trim()) {
    return { ok: false, errorType: 'unknown', details: 'missing_model' };
  }
  const credentialCheck = hasUsableProbeCredentials(probeConfig);
  if (!credentialCheck.ok) {
    return {
      ok: false,
      errorType: 'missing_key',
      ...(credentialCheck.details ? { details: credentialCheck.details } : {}),
    };
  }

  try {
    const result = await runClaudeOneShot(
      `Please reply with exactly: ${PROBE_ACK}`,
      probeConfig,
      `You are a connectivity probe. Do not use tools. Reply with exactly: ${PROBE_ACK}`
    );
    if (result.errors.length > 0) {
      return mapClaudeSdkError(result.errors.join('; '), result.durationMs);
    }
    if (!result.text) {
      return {
        ok: false,
        latencyMs: result.durationMs,
        errorType: 'unknown',
        details: 'empty_probe_response',
      };
    }
    if (normalizeProbeAck(result.text) !== PROBE_ACK) {
      return {
        ok: false,
        latencyMs: result.durationMs,
        errorType: 'unknown',
        details: `probe_response_mismatch:${result.text.slice(0, 120)}`,
      };
    }
    return {
      ok: true,
      latencyMs: result.durationMs,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return mapClaudeSdkError(details, 0);
  }
}

export async function generateTitleWithClaudeSdk(
  titlePrompt: string,
  config: AppConfig,
  cwdOverride?: string
): Promise<string | null> {
  try {
    const result = await runClaudeOneShot(
      titlePrompt,
      config,
      'Generate a concise title. Reply with only the title text and no extra markup.',
      cwdOverride
    );
    if (result.errors.length > 0) {
      logWarn('[SessionTitle] Claude SDK title generation failed', { errors: result.errors });
      return null;
    }
    return normalizeGeneratedTitle(result.text);
  } catch (error) {
    logWarn('[SessionTitle] Claude SDK title generation threw', error);
    return null;
  }
}
