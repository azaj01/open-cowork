import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { AppConfig } from '../config/config-store';
import { log, logError, logWarn } from '../utils/logger';
import {
  resolveUnifiedGatewayProfile,
  type ProxyRouteDecision,
  type UnifiedGatewayProfile,
} from '../claude/unified-gateway-resolver';

const PROXY_VENDOR_COMMIT = 'dd4a29aff3b470710187505daaeed20ea025e5bf';
const PROXY_SDK_API_KEY = 'sk-ant-local-proxy';
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT_START = 18082;
const PROXY_PORT_END = 18120;
const PROXY_START_TIMEOUT_MS = 25000;
const PROXY_STOP_TIMEOUT_MS = 5000;
const PROXY_REQUIREMENTS_FINGERPRINT = [
  `vendor=${PROXY_VENDOR_COMMIT}`,
  'fastapi[standard]>=0.115.11',
  'uvicorn>=0.34.0',
  'httpx>=0.25.0',
  'pydantic>=2.0.0',
  'litellm>=1.77.7',
  'python-dotenv>=1.0.0',
  'google-auth>=2.41.1',
  'google-cloud-aiplatform>=1.120.0',
].join('|');

export interface ClaudeProxyRuntimeState {
  baseUrl: string;
  host: string;
  port: number;
  upstreamKind: UnifiedGatewayProfile['upstreamKind'];
  signature: string;
  sdkApiKey: string;
  pid: number;
}

interface ActiveProxyState extends ClaudeProxyRuntimeState {
  process: ChildProcess;
  logs: string[];
}

function resolveVendorRoot(): string | null {
  let appPathCandidate = '';
  try {
    if (typeof app?.getAppPath === 'function') {
      appPathCandidate = app.getAppPath();
    }
  } catch {
    appPathCandidate = '';
  }

  const candidates = [
    path.resolve(process.cwd(), 'vendor', 'claude-code-proxy'),
    path.resolve(process.cwd(), 'src', 'vendor', 'claude-code-proxy'),
    path.resolve(process.cwd(), 'app.asar.unpacked', 'vendor', 'claude-code-proxy'),
    ...(appPathCandidate ? [path.resolve(appPathCandidate, 'vendor', 'claude-code-proxy')] : []),
    ...(appPathCandidate ? [path.resolve(appPathCandidate, 'app.asar.unpacked', 'vendor', 'claude-code-proxy')] : []),
    path.resolve(process.resourcesPath || '', 'vendor', 'claude-code-proxy'),
    path.resolve(process.resourcesPath || '', 'app.asar.unpacked', 'vendor', 'claude-code-proxy'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'server.py'))) {
      return candidate;
    }
  }
  return null;
}

function resolveRuntimeRoot(): string {
  try {
    if (typeof app?.getPath === 'function') {
      return path.join(app.getPath('userData'), 'claude-proxy-runtime');
    }
  } catch {
    // Fall through to temp dir in unit tests or non-Electron runtime.
  }
  return path.join(os.tmpdir(), 'open-cowork', 'claude-proxy-runtime');
}

function resolveVenvPython(runtimeRoot: string): string {
  if (process.platform === 'win32') {
    return path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe');
  }
  return path.join(runtimeRoot, 'venv', 'bin', 'python3');
}

function resolveVersionMarker(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'runtime-version.txt');
}

function resolveSystemPythonCandidate(): string {
  const explicit = process.env.OPEN_COWORK_PYTHON_PATH?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const candidates = process.platform === 'win32'
    ? ['python.exe', 'python']
    : ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3', 'python'];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Continue.
    }
  }

  throw new Error(
    'proxy_boot_failed:python_not_found:Unable to resolve python3 runtime for claude-code-proxy'
  );
}

function buildProfileSignature(profile: UnifiedGatewayProfile): string {
  return [
    profile.upstreamKind,
    profile.upstreamBaseUrl,
    profile.upstreamApiKey,
    profile.model,
    profile.provider,
    profile.customProtocol || 'anthropic',
  ].join('::');
}

function trimLogs(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }
  return lines.slice(-12).join('\n');
}

async function waitForProcessExit(processRef: ChildProcess, timeoutMs: number): Promise<void> {
  if (processRef.exitCode !== null || processRef.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, timeoutMs);
    processRef.once('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function findAvailablePort(start = PROXY_PORT_START, end = PROXY_PORT_END): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, PROXY_HOST);
    });
    if (available) {
      return port;
    }
  }
  throw new Error(`proxy_boot_failed:no_available_port:${start}-${end}`);
}

function buildProxyEnvironment(profile: UnifiedGatewayProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PREFERRED_PROVIDER: profile.upstreamKind,
    BIG_MODEL: profile.model,
    SMALL_MODEL: profile.model,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: '',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
    GEMINI_API_KEY: '',
  };

  if (profile.upstreamKind === 'openai') {
    env.OPENAI_API_KEY = profile.upstreamApiKey;
    env.OPENAI_BASE_URL = profile.upstreamBaseUrl;
  } else {
    env.ANTHROPIC_API_KEY = profile.upstreamApiKey;
    env.ANTHROPIC_BASE_URL = profile.upstreamBaseUrl;
  }

  return env;
}

async function waitForHealthy(baseUrl: string, processRef: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) {
      throw new Error(
        `proxy_boot_failed:process_exited:${processRef.exitCode}:${lastError || trimLogs(logs)}`
      );
    }

    try {
      const response = await fetch(`${baseUrl}/`, { method: 'GET' });
      if (response.ok) {
        return;
      }
      lastError = `status=${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`proxy_health_failed:timeout:${lastError || trimLogs(logs)}`);
}

export class ClaudeProxyManager {
  private activeState: ActiveProxyState | null = null;
  private operationQueue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  isEnabled(): boolean {
    return process.env.COWORK_DISABLE_CLAUDE_PROXY !== '1';
  }

  getCurrentState(): ClaudeProxyRuntimeState | null {
    if (!this.activeState) {
      return null;
    }
    const { process: _ignored, logs: _logs, ...rest } = this.activeState;
    return rest;
  }

  resolveRoute(config: AppConfig): ProxyRouteDecision {
    return resolveUnifiedGatewayProfile(config);
  }

  async ensureReadyForConfig(config: AppConfig): Promise<ClaudeProxyRuntimeState> {
    const decision = this.resolveRoute(config);
    if (!decision.ok || !decision.profile) {
      const reason = decision.reason || 'unknown';
      if (reason === 'missing_key') {
        throw new Error('proxy_upstream_auth_failed:missing_key');
      }
      if (reason === 'missing_base_url') {
        throw new Error('proxy_upstream_not_found:missing_base_url');
      }
      throw new Error(`proxy_upstream_not_found:${reason}`);
    }
    return this.ensureReady(decision.profile);
  }

  async warmupForConfig(config: AppConfig): Promise<void> {
    if (!this.isEnabled()) {
      await this.stop();
      return;
    }
    const decision = this.resolveRoute(config);
    if (!decision.ok || !decision.profile) {
      await this.stop();
      logWarn('[ClaudeProxy] Skip warmup due to unresolved route', {
        reason: decision.reason,
        provider: config.provider,
        customProtocol: config.customProtocol,
      });
      return;
    }
    await this.ensureReady(decision.profile);
  }

  async ensureReady(profile: UnifiedGatewayProfile): Promise<ClaudeProxyRuntimeState> {
    return this.enqueue(async () => {
      if (!this.isEnabled()) {
        throw new Error('proxy_boot_failed:disabled_by_env');
      }

      const signature = buildProfileSignature(profile);
      if (this.activeState && this.activeState.signature === signature && this.activeState.process.exitCode === null) {
        const { process: _process, logs: _logs, ...rest } = this.activeState;
        return rest;
      }

      await this.stopInternal();
      const runtime = await this.startInternal(profile, signature);
      return runtime;
    });
  }

  async stop(): Promise<void> {
    await this.enqueue(async () => {
      await this.stopInternal();
    });
  }

  private async ensurePythonRuntime(vendorRoot: string): Promise<string> {
    const runtimeRoot = resolveRuntimeRoot();
    fs.mkdirSync(runtimeRoot, { recursive: true });

    const venvPython = resolveVenvPython(runtimeRoot);
    const markerFile = resolveVersionMarker(runtimeRoot);
    const marker = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf-8').trim() : '';

    if (fs.existsSync(venvPython) && marker === PROXY_REQUIREMENTS_FINGERPRINT) {
      return venvPython;
    }

    const bootstrapPython = resolveSystemPythonCandidate();
    if (!fs.existsSync(venvPython)) {
      execFileSync(bootstrapPython, ['-m', 'venv', path.join(runtimeRoot, 'venv')], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
    }

    execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
      cwd: vendorRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 10,
      timeout: 180_000,
    });
    execFileSync(
      venvPython,
      ['-m', 'pip', 'install', '--upgrade', ...PROXY_REQUIREMENTS_FINGERPRINT.split('|').slice(1)],
      {
        cwd: vendorRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024 * 20,
        timeout: 300_000,
      }
    );

    fs.writeFileSync(markerFile, PROXY_REQUIREMENTS_FINGERPRINT, 'utf-8');
    return venvPython;
  }

  private async startInternal(
    profile: UnifiedGatewayProfile,
    signature: string
  ): Promise<ClaudeProxyRuntimeState> {
    const vendorRoot = resolveVendorRoot();
    if (!vendorRoot) {
      throw new Error('proxy_boot_failed:vendor_not_found');
    }
    log('[ClaudeProxy] Resolved vendor root', { vendorRoot });

    const venvPython = await this.ensurePythonRuntime(vendorRoot);
    const port = await findAvailablePort();
    const baseUrl = `http://${PROXY_HOST}:${port}`;

    const logs: string[] = [];
    const child = spawn(
      venvPython,
      ['-m', 'uvicorn', 'server:app', '--host', PROXY_HOST, '--port', String(port), '--log-level', 'warning'],
      {
        cwd: vendorRoot,
        env: buildProxyEnvironment(profile),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    child.stdout?.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) logs.push(line);
      if (logs.length > 200) logs.shift();
    });
    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) logs.push(line);
      if (logs.length > 200) logs.shift();
    });

    try {
      await waitForHealthy(baseUrl, child, logs);
    } catch (error) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill failures.
      }
      await waitForProcessExit(child, 1500);
      throw error;
    }

    this.activeState = {
      baseUrl,
      host: PROXY_HOST,
      port,
      upstreamKind: profile.upstreamKind,
      signature,
      sdkApiKey: PROXY_SDK_API_KEY,
      pid: child.pid || -1,
      process: child,
      logs,
    };

    log('[ClaudeProxy] Started', {
      baseUrl,
      upstreamKind: profile.upstreamKind,
      pid: child.pid || -1,
      provider: profile.provider,
      customProtocol: profile.customProtocol,
      vendorCommit: PROXY_VENDOR_COMMIT,
    });

    const { process: _process, logs: _logs, ...runtime } = this.activeState;
    return runtime;
  }

  private async stopInternal(): Promise<void> {
    if (!this.activeState) {
      return;
    }

    const active = this.activeState;
    this.activeState = null;

    try {
      if (active.process.exitCode === null) {
        active.process.kill('SIGTERM');
      }
      await waitForProcessExit(active.process, PROXY_STOP_TIMEOUT_MS);
      if (active.process.exitCode === null) {
        active.process.kill('SIGKILL');
        await waitForProcessExit(active.process, 1500);
      }
      if (active.process.exitCode === null) {
        throw new Error('proxy_stop_failed:process_still_running_after_sigkill');
      }
    } catch (error) {
      logError('[ClaudeProxy] Failed to stop process cleanly', error);
      throw error;
    }

    log('[ClaudeProxy] Stopped', {
      pid: active.pid,
      port: active.port,
    });
  }
}

export const claudeProxyManager = new ClaudeProxyManager();
