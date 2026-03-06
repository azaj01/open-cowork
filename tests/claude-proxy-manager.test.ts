import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/main/config/config-store';
import type { UnifiedGatewayProfile } from '../src/main/claude/unified-gateway-resolver';
import {
  buildProfileSignature,
  buildProxyEnvironment,
  ClaudeProxyManager,
  PROXY_REQUIREMENTS_FINGERPRINT,
  PROXY_RUNTIME_VERSION_FILENAME,
  resolveBundledPythonCandidate,
  resolveBundledPythonRuntime,
} from '../src/main/proxy/claude-proxy-manager';

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: 'custom',
    apiKey: 'sk-test',
    baseUrl: 'https://api.duckcoding.ai/v1',
    customProtocol: 'openai',
    model: 'gpt-5.3-codex',
    openaiMode: 'responses',
    activeProfileKey: 'custom:openai',
    profiles: {},
    activeConfigSetId: 'default',
    configSets: [],
    claudeCodePath: '',
    defaultWorkdir: '',
    globalSkillsPath: '',
    enableDevLogs: true,
    sandboxEnabled: false,
    enableThinking: false,
    isConfigured: true,
    ...overrides,
  };
}

const runtimeState = {
  baseUrl: 'http://127.0.0.1:18082',
  host: '127.0.0.1',
  port: 18082,
  upstreamKind: 'openai',
  signature: 'test-signature',
  sdkApiKey: 'sk-ant-local-proxy',
  pid: 9999,
} as const;

const profile: UnifiedGatewayProfile = {
  upstreamKind: 'openai',
  upstreamBaseUrl: 'https://api.duckcoding.ai/v1',
  upstreamApiKey: 'sk-test',
  model: 'gpt-5.3-codex',
  requiresProxy: true,
  provider: 'custom',
  customProtocol: 'openai',
};

const ORIGINAL_DISABLE_PROXY = process.env.COWORK_DISABLE_CLAUDE_PROXY;
let tempDirToCleanup: string | null = null;

function createManagedState(signature: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ...runtimeState,
    signature,
    process: {
      exitCode: null,
      killed: false,
      kill: vi.fn(),
      once: vi.fn(),
    },
    logs: [],
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
    leaseCount: 0,
    ...overrides,
  };
}

function setManagedState(manager: ClaudeProxyManager, signature: string, overrides: Partial<Record<string, unknown>> = {}): void {
  const state = createManagedState(signature, overrides);
  (manager as unknown as { activeStates: Map<string, unknown>; latestSignature: string | null }).activeStates.set(signature, state);
  (manager as unknown as { latestSignature: string | null }).latestSignature = signature;
}

function createBundledPythonLayout(includeProxyDeps = false, includeRuntimeMarker = false): string {
  tempDirToCleanup = mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-python-'));
  const bundledPython = path.join(tempDirToCleanup, 'python', 'bin', 'python3');
  const pythonRoot = path.join(tempDirToCleanup, 'python');
  const sitePackages = path.join(tempDirToCleanup, 'python', 'site-packages');
  mkdirSync(path.dirname(bundledPython), { recursive: true });
  mkdirSync(sitePackages, { recursive: true });
  writeFileSync(bundledPython, '#!/bin/sh\n');
  mkdirSync(path.join(sitePackages, 'PIL'), { recursive: true });
  mkdirSync(path.join(sitePackages, 'Quartz'), { recursive: true });
  if (includeProxyDeps) {
    [
      'fastapi',
      'uvicorn',
      'httpx',
      'pydantic',
      'litellm',
      'dotenv',
      path.join('google', 'auth'),
      path.join('google', 'cloud', 'aiplatform'),
    ].forEach((entry) => {
      mkdirSync(path.join(sitePackages, entry), { recursive: true });
    });
  }
  if (includeRuntimeMarker) {
    writeFileSync(
      path.join(pythonRoot, PROXY_RUNTIME_VERSION_FILENAME),
      PROXY_REQUIREMENTS_FINGERPRINT,
      'utf-8'
    );
  }
  return bundledPython;
}

describe('ClaudeProxyManager', () => {
  beforeEach(() => {
    delete process.env.COWORK_DISABLE_CLAUDE_PROXY;
  });

  afterEach(() => {
    if (ORIGINAL_DISABLE_PROXY === undefined) {
      delete process.env.COWORK_DISABLE_CLAUDE_PROXY;
    } else {
      process.env.COWORK_DISABLE_CLAUDE_PROXY = ORIGINAL_DISABLE_PROXY;
    }
    if (tempDirToCleanup) {
      rmSync(tempDirToCleanup, { recursive: true, force: true });
      tempDirToCleanup = null;
    }
    vi.restoreAllMocks();
  });

  it('maps missing key route errors to proxy_upstream_auth_failed', async () => {
    const manager = new ClaudeProxyManager();
    vi.spyOn(manager, 'resolveRoute').mockReturnValue({
      ok: false,
      reason: 'missing_key',
    });

    await expect(manager.ensureReadyForConfig(createConfig())).rejects.toThrow(
      'proxy_upstream_auth_failed:missing_key'
    );
  });

  it('maps missing base url route errors to proxy_upstream_not_found', async () => {
    const manager = new ClaudeProxyManager();
    vi.spyOn(manager, 'resolveRoute').mockReturnValue({
      ok: false,
      reason: 'missing_base_url',
    });

    await expect(manager.ensureReadyForConfig(createConfig())).rejects.toThrow(
      'proxy_upstream_not_found:missing_base_url'
    );
  });

  it('stops active proxy during warmup when proxy is disabled by env', async () => {
    const manager = new ClaudeProxyManager();
    process.env.COWORK_DISABLE_CLAUDE_PROXY = '1';
    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue();
    const resolveRouteSpy = vi.spyOn(manager, 'resolveRoute');

    await manager.warmupForConfig(createConfig());

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(resolveRouteSpy).not.toHaveBeenCalled();
  });

  it('preserves the active proxy during warmup when route cannot be resolved', async () => {
    const manager = new ClaudeProxyManager();
    setManagedState(manager, 'active-signature');
    vi.spyOn(manager, 'resolveRoute').mockReturnValue({
      ok: false,
      reason: 'missing_key',
    });
    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue();
    const ensureReadySpy = vi.spyOn(manager, 'ensureReady').mockResolvedValue(runtimeState);

    await manager.warmupForConfig(createConfig());

    expect(stopSpy).not.toHaveBeenCalled();
    expect(ensureReadySpy).not.toHaveBeenCalled();
  });

  it('warms up proxy for resolved routes', async () => {
    const manager = new ClaudeProxyManager();
    vi.spyOn(manager, 'resolveRoute').mockReturnValue({
      ok: true,
      reason: 'ok',
      profile,
    });
    vi.spyOn(manager, 'stop').mockResolvedValue();
    const ensureReadySpy = vi.spyOn(manager, 'ensureReady').mockResolvedValue(runtimeState);

    await manager.warmupForConfig(createConfig());

    expect(ensureReadySpy).toHaveBeenCalledTimes(1);
    expect(ensureReadySpy).toHaveBeenCalledWith(profile);
  });

  it('does not restart a live proxy during warmup when config signature changes', async () => {
    const manager = new ClaudeProxyManager();
    setManagedState(manager, 'active-signature');
    vi.spyOn(manager, 'resolveRoute').mockReturnValue({
      ok: true,
      reason: 'ok',
      profile: {
        ...profile,
        model: 'openai/gpt-4.1-mini',
      },
    });
    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue();
    const ensureReadySpy = vi.spyOn(manager, 'ensureReady').mockResolvedValue(runtimeState);

    await manager.warmupForConfig(createConfig());

    expect(stopSpy).not.toHaveBeenCalled();
    expect(ensureReadySpy).toHaveBeenCalledTimes(1);
  });

  it('forwards codex oauth headers into the proxy environment', () => {
    const env = buildProxyEnvironment({
      ...profile,
      upstreamApiKey: 'oauth-local-token',
      upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamHeaders: {
        'User-Agent': 'CodexBar',
        'ChatGPT-Account-Id': 'acct_123456',
      },
      openaiAccountId: 'acct_123456',
      useCodexOAuth: true,
    });

    expect(env.OPENAI_API_KEY).toBe('oauth-local-token');
    expect(env.OPENAI_BASE_URL).toBe('https://chatgpt.com/backend-api/codex');
    expect(env.OPENAI_ACCOUNT_ID).toBe('acct_123456');
    expect(env.OPENAI_CODEX_OAUTH).toBe('1');
    expect(env.OPENAI_DEFAULT_HEADERS_JSON).toBe(
      JSON.stringify({
        'User-Agent': 'CodexBar',
        'ChatGPT-Account-Id': 'acct_123456',
      })
    );
  });

  it('builds gemini proxy environment with google provider mapping and custom base url', () => {
    const env = buildProxyEnvironment({
      upstreamKind: 'gemini',
      upstreamBaseUrl: 'https://gemini-proxy.example/v1',
      upstreamApiKey: 'AIza-test',
      model: 'gemini/gemini-2.5-flash',
      requiresProxy: true,
      provider: 'custom',
      customProtocol: 'gemini',
    });

    expect(env.PREFERRED_PROVIDER).toBe('google');
    expect(env.GEMINI_API_KEY).toBe('AIza-test');
    expect(env.GEMINI_BASE_URL).toBe('https://gemini-proxy.example/v1');
    expect(env.OPENAI_API_KEY).toBe('');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('');
  });

  it('hashes proxy signatures without exposing raw credentials', () => {
    const signature = buildProfileSignature({
      ...profile,
      upstreamApiKey: 'oauth-local-token',
      upstreamHeaders: {
        'User-Agent': 'CodexBar',
        'ChatGPT-Account-Id': 'acct_123456',
      },
      openaiAccountId: 'acct_123456',
      useCodexOAuth: true,
    });

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(signature).not.toContain('oauth-local-token');
    expect(signature).not.toContain('acct_123456');
    expect(signature).not.toContain('CodexBar');
  });

  it('keeps existing live proxy processes when ensuring a new signature', async () => {
    const manager = new ClaudeProxyManager();
    const startInternalSpy = vi.spyOn(manager as never, 'startInternal' as never);
    const stopStateInternalSpy = vi.spyOn(manager as never, 'stopStateInternal' as never).mockResolvedValue(undefined);

    startInternalSpy
      .mockResolvedValueOnce(createManagedState('signature-old'))
      .mockResolvedValueOnce(createManagedState('signature-new', {
        baseUrl: 'http://127.0.0.1:18083',
        port: 18083,
        pid: 10000,
      }));

    await manager.ensureReady(profile);
    await manager.ensureReady({
      ...profile,
      model: 'openai/gpt-4.1-mini',
    });

    expect(stopStateInternalSpy).not.toHaveBeenCalled();
    expect((manager as unknown as { activeStates: Map<string, unknown> }).activeStates.size).toBe(2);
  });

  it('does not prune leased proxy processes even when they are stale', async () => {
    const manager = new ClaudeProxyManager();
    const staleLeasedState = createManagedState('signature-old', {
      leaseCount: 1,
      lastUsedAt: Date.now() - (11 * 60 * 1000),
    });
    const staleFreeState = createManagedState('signature-free', {
      leaseCount: 0,
      lastUsedAt: Date.now() - (11 * 60 * 1000),
      port: 18084,
      pid: 10001,
    });
    (manager as unknown as { activeStates: Map<string, unknown> }).activeStates.set('signature-old', staleLeasedState);
    (manager as unknown as { activeStates: Map<string, unknown> }).activeStates.set('signature-free', staleFreeState);
    const stopStateInternalSpy = vi.spyOn(manager as never, 'stopStateInternal' as never).mockResolvedValue(undefined);

    await (manager as never).pruneStaleStates(new Set());

    expect(stopStateInternalSpy).toHaveBeenCalledTimes(1);
    expect(stopStateInternalSpy).toHaveBeenCalledWith(staleFreeState);
    expect((manager as unknown as { activeStates: Map<string, unknown> }).activeStates.has('signature-old')).toBe(true);
  });

  it('resolves bundled python from app resources before falling back to system python', () => {
    const bundledPython = createBundledPythonLayout();

    const resolved = resolveBundledPythonCandidate({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: tempDirToCleanup,
    });

    expect(resolved).toBe(bundledPython);
  });

  it('resolves bundled python from packaged linux resources', () => {
    const bundledPython = createBundledPythonLayout();

    const resolved = resolveBundledPythonCandidate({
      platform: 'linux',
      arch: 'x64',
      resourcesPath: tempDirToCleanup,
    });

    expect(resolved).toBe(bundledPython);
  });

  it('rejects bundled python runtime when proxy dependencies are stale or unversioned', () => {
    createBundledPythonLayout(true, false);

    const resolved = resolveBundledPythonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: tempDirToCleanup || undefined,
    });

    expect(resolved).toBeNull();
  });

  it('returns bundled python runtime only when proxy dependencies and runtime marker are present', () => {
    createBundledPythonLayout(true, true);

    const resolved = resolveBundledPythonRuntime({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: tempDirToCleanup || undefined,
    });

    expect(resolved).toMatchObject({
      python: path.join(tempDirToCleanup || '', 'python', 'bin', 'python3'),
      pythonRoot: path.join(tempDirToCleanup || '', 'python'),
      source: 'bundled',
    });
    expect(resolved?.env.PYTHONHOME).toBe(path.join(tempDirToCleanup || '', 'python'));
    expect(resolved?.env.PYTHONPATH).toContain(path.join(tempDirToCleanup || '', 'python', 'site-packages'));
  });
});
