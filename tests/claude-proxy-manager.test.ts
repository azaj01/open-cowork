import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/main/config/config-store';
import type { UnifiedGatewayProfile } from '../src/main/claude/unified-gateway-resolver';
import { ClaudeProxyManager } from '../src/main/proxy/claude-proxy-manager';

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

  it('stops active proxy during warmup when route cannot be resolved', async () => {
    const manager = new ClaudeProxyManager();
    vi.spyOn(manager, 'resolveRoute').mockReturnValue({
      ok: false,
      reason: 'missing_key',
    });
    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue();
    const ensureReadySpy = vi.spyOn(manager, 'ensureReady').mockResolvedValue(runtimeState);

    await manager.warmupForConfig(createConfig());

    expect(stopSpy).toHaveBeenCalledTimes(1);
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
});
