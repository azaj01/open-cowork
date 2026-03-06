import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { Session, Message, TraceStep, ServerEvent, ContentBlock } from '../../renderer/types';
import { v4 as uuidv4 } from 'uuid';
import { PathResolver } from '../sandbox/path-resolver';
import { MCPManager } from '../mcp/mcp-manager';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import { credentialsStore, type UserCredential } from '../credentials/credentials-store';
import { log, logWarn, logError } from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { setMaxListeners } from 'node:events';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import { pathConverter } from '../sandbox/wsl-bridge';
import { SandboxSync } from '../sandbox/sandbox-sync';
import { extractArtifactsFromText, buildArtifactTraceSteps } from '../utils/artifact-parser';
import { buildMcpToolsPrompt } from '../utils/cowork-instructions';
import { buildClaudeEnv, getClaudeEnvOverrides } from './claude-env';
import { buildThinkingOptions } from './thinking-options';
import { isSyntheticAssistantTextBlock } from './assistant-text-filter';
import { PluginRuntimeService } from '../skills/plugin-runtime-service';
import { configStore } from '../config/config-store';
import { resolveClaudeCodeExecutablePath } from './claude-code-path';
import { shouldUseUnifiedClaudeProxy, shouldUseUnifiedClaudeSdk } from '../session/claude-unified-mode';
import { resolveUnifiedGatewayProfile } from './unified-gateway-resolver';
import { claudeProxyManager } from '../proxy/claude-proxy-manager';
import { isNodeExecutable, withBunHashShimEnv, withBunHashShimNodeArgs } from './bun-shim';
// import { PathGuard } from '../sandbox/path-guard';

// Virtual workspace path shown to the model (hides real sandbox path)
const VIRTUAL_WORKSPACE_PATH = '/workspace';

// Cache for shell environment (loaded once at startup)
let cachedShellEnv: NodeJS.ProcessEnv | null = null;

/**
 * Get shell environment with proper PATH (including node, npm, etc.)
 * GUI apps on macOS don't inherit shell PATH, so we need to extract it
 */
function getShellEnvironment(): NodeJS.ProcessEnv {
  const fnStart = Date.now();
  
  if (cachedShellEnv) {
    log(`[ShellEnv] Returning cached env (0ms)`);
    return cachedShellEnv;
  }

  const platform = process.platform;
  let shellPath = process.env.PATH || '';
  
  log('[ShellEnv] Original PATH:', shellPath);
  log(`[ShellEnv] Starting shell PATH extraction...`);

  if (platform === 'darwin' || platform === 'linux') {
    try {
      const shellEnvTimeoutMs = Number.parseInt(process.env.COWORK_SHELL_ENV_TIMEOUT_MS || '600', 10);
      const effectiveShellEnvTimeoutMs = Number.isFinite(shellEnvTimeoutMs) && shellEnvTimeoutMs > 0
        ? shellEnvTimeoutMs
        : 1500;
      // Get PATH from login shell (includes nvm, homebrew, etc.)
      const execStart = Date.now();
      const shellEnvOutput = execSync('/bin/bash -l -c "echo $PATH"', {
        encoding: 'utf-8',
        timeout: effectiveShellEnvTimeoutMs,
      }).trim();
      log(`[ShellEnv] execSync took ${Date.now() - execStart}ms`);
      
      if (shellEnvOutput) {
        shellPath = shellEnvOutput;
        log('[ShellEnv] Got PATH from login shell:', shellPath);
      }
    } catch (e) {
      logWarn('[ShellEnv] Failed to get PATH from login shell, using fallback');
      
      // Add common paths as fallback
      const home = process.env.HOME || '';
      const fallbackPaths = [
        '/opt/homebrew/bin',                    // Homebrew Apple Silicon
        '/usr/local/bin',                       // Homebrew Intel / system
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        `${home}/.local/bin`,                   // pip user installs
        `${home}/.npm-global/bin`,              // npm global
      ];
      
      // Expand nvm paths
      const nvmDir = path.join(home, '.nvm/versions/node');
      if (fs.existsSync(nvmDir)) {
        try {
          const versions = fs.readdirSync(nvmDir);
          for (const version of versions) {
            fallbackPaths.push(path.join(nvmDir, version, 'bin'));
          }
        } catch (e) { /* ignore */ }
      }
      
      shellPath = [...fallbackPaths.filter(p => fs.existsSync(p) || p.includes('*')), shellPath].join(':');
    }
  }

  cachedShellEnv = {
    ...process.env,
    PATH: shellPath,
  };
  
  log(`[ShellEnv] Total getShellEnvironment took ${Date.now() - fnStart}ms`);
  return cachedShellEnv;
}

function safeStringify(value: unknown, space = 0): string {
  try {
    return JSON.stringify(value, null, space);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return `[Unserializable: ${details}]`;
  }
}

function appendDiagnosticParts(parts: string[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendDiagnosticParts(parts, entry);
    }
    return;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    parts.push(String(value));
    return;
  }

  if (value == null) {
    return;
  }

  const serialized = safeStringify(value);
  if (serialized && serialized !== '{}' && serialized !== '[]') {
    parts.push(serialized);
  }
}

function toErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }
  }
  const serialized = safeStringify(error);
  if (serialized.startsWith('[Unserializable:')) {
    return String(error);
  }
  return serialized;
}

function toUserFacingErrorText(errorText: string): string {
  if (errorText.toLowerCase().includes('first_response_timeout')) {
    return '模型响应超时：长时间未收到上游返回，请稍后重试或检查当前模型/网关负载。';
  }
  if (errorText.toLowerCase().includes('empty_success_result')) {
    return '模型返回了一个空的成功结果，当前模型或网关兼容性可能有问题，请重试或切换协议后再试。';
  }
  return errorText;
}

function isSyntheticEmptyAssistantText(text: string): boolean {
  return isSyntheticAssistantTextBlock(text);
}

function redactEnvForLog(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!env) {
    return undefined;
  }
  const redacted: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null) {
      redacted[key] = value;
      continue;
    }
    const upper = key.toUpperCase();
    const isSecretLike =
      upper.includes('KEY')
      || upper.includes('TOKEN')
      || upper.includes('SECRET')
      || upper.includes('PASSWORD')
      || upper.includes('AUTH');
    if (isSecretLike) {
      redacted[key] = value ? '***' : value;
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

function redactQueryInputForLog(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }
  const queryInput = input as { prompt?: unknown; options?: Record<string, unknown> };
  if (!queryInput.options || typeof queryInput.options !== 'object') {
    return input;
  }
  const options = { ...queryInput.options };
  options.env = redactEnvForLog(options.env as NodeJS.ProcessEnv | undefined);
  return {
    ...queryInput,
    options,
  };
}

function summarizeQueryInputForLog(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    return { kind: typeof input };
  }
  const queryInput = input as {
    prompt?: unknown;
    options?: Record<string, unknown>;
  };
  const options = queryInput.options && typeof queryInput.options === 'object'
    ? queryInput.options
    : undefined;

  const prompt = queryInput.prompt;
  const promptType = typeof prompt === 'string'
    ? 'text'
    : prompt && typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
      ? 'stream'
      : typeof prompt;
  const promptLength = typeof prompt === 'string' ? prompt.length : undefined;

  const mcpServers = options?.mcpServers && typeof options.mcpServers === 'object'
    ? Object.keys(options.mcpServers as Record<string, unknown>)
    : [];
  const env = options?.env && typeof options.env === 'object'
    ? (options.env as NodeJS.ProcessEnv)
    : undefined;

  return {
    promptType,
    promptLength,
    model: typeof options?.model === 'string' ? options.model : undefined,
    cwd: typeof options?.cwd === 'string' ? options.cwd : undefined,
    maxTurns: typeof options?.maxTurns === 'number' ? options.maxTurns : undefined,
    mcpServerCount: mcpServers.length,
    mcpServers,
    envSummary: {
      anthropicBaseUrl: env?.ANTHROPIC_BASE_URL || '(default)',
      anthropicApiKeySet: Boolean(env?.ANTHROPIC_API_KEY),
      anthropicAuthTokenSet: Boolean(env?.ANTHROPIC_AUTH_TOKEN),
      claudeModel: env?.CLAUDE_MODEL || '(unset)',
    },
  };
}

function summarizeSdkMessageForLog(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== 'object') {
    return { kind: typeof message };
  }
  const sdkMessage = message as Record<string, unknown>;
  const type = typeof sdkMessage.type === 'string' ? sdkMessage.type : 'unknown';

  if (type === 'system') {
    const tools = Array.isArray(sdkMessage.tools) ? sdkMessage.tools : [];
    const mcpServers = Array.isArray(sdkMessage.mcp_servers) ? sdkMessage.mcp_servers : [];
    return {
      type,
      subtype: sdkMessage.subtype,
      sessionId: sdkMessage.session_id,
      model: sdkMessage.model,
      apiKeySource: sdkMessage.apiKeySource,
      toolCount: tools.length,
      mcpServerCount: mcpServers.length,
    };
  }

  if (type === 'assistant') {
    const messageNode = sdkMessage.message && typeof sdkMessage.message === 'object'
      ? (sdkMessage.message as Record<string, unknown>)
      : {};
    const content = Array.isArray(messageNode.content) ? messageNode.content : [];
    const textLength = content.reduce((total, block) => {
      if (!block || typeof block !== 'object') {
        return total;
      }
      const text = (block as { text?: unknown }).text;
      return total + (typeof text === 'string' ? text.length : 0);
    }, 0);
    return {
      type,
      error: sdkMessage.error,
      sessionId: sdkMessage.session_id,
      contentBlockCount: content.length,
      textLength,
    };
  }

  if (type === 'result') {
    return {
      type,
      subtype: sdkMessage.subtype,
      isError: sdkMessage.is_error,
      durationMs: sdkMessage.duration_ms,
      durationApiMs: sdkMessage.duration_api_ms,
      numTurns: sdkMessage.num_turns,
      sessionId: sdkMessage.session_id,
    };
  }

  return { type };
}

interface AskUserQuestionOption {
  label: string;
  description?: string;
}

interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
}

function sanitizeAskUserQuestions(rawQuestions: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  return rawQuestions
    .map((item): AskUserQuestionItem | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const record = item as Record<string, unknown>;
      const question = typeof record.question === 'string' ? record.question.trim() : '';
      if (!question) {
        return null;
      }

      const sanitized: AskUserQuestionItem = { question };
      if (typeof record.header === 'string' && record.header.trim().length > 0) {
        sanitized.header = record.header.trim();
      }

      if (Array.isArray(record.options)) {
        const options = record.options
          .map((option): AskUserQuestionOption | null => {
            if (!option || typeof option !== 'object') {
              return null;
            }
            const optionRecord = option as Record<string, unknown>;
            const label = typeof optionRecord.label === 'string' ? optionRecord.label.trim() : '';
            if (!label) {
              return null;
            }
            const sanitizedOption: AskUserQuestionOption = { label };
            if (typeof optionRecord.description === 'string' && optionRecord.description.trim().length > 0) {
              sanitizedOption.description = optionRecord.description.trim();
            }
            return sanitizedOption;
          })
          .filter((option): option is AskUserQuestionOption => option !== null);

        if (options.length > 0) {
          sanitized.options = options;
        }
      }

      if (typeof record.multiSelect === 'boolean') {
        sanitized.multiSelect = record.multiSelect;
      }

      return sanitized;
    })
    .filter((question): question is AskUserQuestionItem => question !== null);
}

function normalizeAskUserAnswers(
  answersJson: string,
  questions: AskUserQuestionItem[]
): Record<string, string> {
  if (!answersJson.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answersJson);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const rawAnswers = parsed as Record<string, unknown>;
  const normalized: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(rawAnswers)) {
    const index = Number(rawKey);
    const key = Number.isInteger(index) && index >= 0 && index < questions.length
      ? String(index)
      : rawKey;

    let value = '';
    if (Array.isArray(rawValue)) {
      value = rawValue
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .join(', ');
    } else if (typeof rawValue === 'string') {
      value = rawValue.trim();
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      value = String(rawValue);
    }

    if (value.length > 0) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function isAskUserQuestionSchemaError(content: string): boolean {
  return content.includes('<tool_use_error>InputValidationError: AskUserQuestion failed')
    && content.includes('unexpected parameter');
}

const ASK_USER_QUESTION_INVALID_ROOT_KEYS = new Set(['type', 'header', 'multiSelect']);

function getInvalidAskUserQuestionRootKeys(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  const root = input as Record<string, unknown>;
  return Object.keys(root).filter((key) => ASK_USER_QUESTION_INVALID_ROOT_KEYS.has(key));
}

function extractStatusCodeFromErrorText(errorText: string): number | null {
  const patterns = [
    /api error(?:\s+detected)?\s*:\s*(\d{3})/i,
    /status\s*code\s*\(?\s*(\d{3})\s*\)?/i,
    /response\s*\[\s*(\d{3})/i,
    /\berror\s*:\s*(\d{3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = errorText.match(pattern);
    if (!match) {
      continue;
    }
    const code = Number.parseInt(match[1], 10);
    if (Number.isFinite(code)) {
      return code;
    }
  }
  return null;
}

function isRetryableApiErrorText(errorText: string): boolean {
  const text = errorText.toLowerCase();
  if (text.includes('first_response_timeout')) {
    return false;
  }
  const statusCode = extractStatusCodeFromErrorText(errorText);
  if (statusCode !== null) {
    if (statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429) {
      return true;
    }
    if (statusCode >= 400 && statusCode < 500) {
      return false;
    }
    if (statusCode >= 500) {
      return true;
    }
  }
  const nonRetryableClientError = (
    text.includes('error: 400')
    || text.includes('error: 401')
    || text.includes('error: 403')
    || text.includes('error: 404')
    || text.includes('error: 422')
    || text.includes('badrequesterror')
    || text.includes('invalid_request_error')
    || text.includes('llm provider not provided')
    || text.includes('invalid api key')
    || text.includes('authentication_failed')
    || text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('proxy_upstream_auth_failed')
    || text.includes('proxy_upstream_not_found')
  );
  if (nonRetryableClientError) {
    return false;
  }

  return (
    text.includes('provider returned error')
    || text.includes('unable to submit request')
    || text.includes('thought signature')
    || text.includes('invalid_argument')
    || text.includes('error: 500')
    || text.includes('error: 502')
    || text.includes('error: 503')
    || text.includes('error: 504')
    || text.includes('timeout')
    || text.includes('econnrefused')
    || text.includes('etimedout')
    || text.includes('eai_again')
    || text.includes('connection reset')
    || text.includes('temporarily unavailable')
    || /api error:\s*5\d\d/.test(text)
    || /response\s*\[\s*5\d\d/.test(text)
  );
}

interface AgentRunnerOptions {
  sendToRenderer: (event: ServerEvent) => void;
  saveMessage?: (message: Message) => void;
}

/**
 * ClaudeAgentRunner - Uses @anthropic-ai/claude-agent-sdk with allowedTools
 * 
 * Environment variables should be set before running:
 *   ANTHROPIC_BASE_URL=https://openrouter.ai/api
 *   ANTHROPIC_AUTH_TOKEN=your_openrouter_api_key
 *   ANTHROPIC_API_KEY="" (must be empty)
 */
// Pending question resolver type
interface PendingQuestion {
  questionId: string;
  resolve: (answer: string) => void;
}

export class ClaudeAgentRunner {
  private sendToRenderer: (event: ServerEvent) => void;
  private saveMessage?: (message: Message) => void;
  private pathResolver: PathResolver;
  private mcpManager?: MCPManager;
  private pluginRuntimeService?: PluginRuntimeService;
  private activeControllers: Map<string, AbortController> = new Map();
  private sdkSessions: Map<string, string> = new Map(); // sessionId -> sdk session_id
  private pendingQuestions: Map<string, PendingQuestion> = new Map(); // questionId -> resolver

  /**
   * Clear SDK session cache for a session
   * Called when session's cwd changes - SDK sessions are bound to cwd
   */
  clearSdkSession(sessionId: string): void {
    if (this.sdkSessions.has(sessionId)) {
      this.sdkSessions.delete(sessionId);
      log('[ClaudeAgentRunner] Cleared SDK session cache for:', sessionId);
    }
  }

  /**
   * Get MCP tools prompt for system instructions
   */
  private getMCPToolsPrompt(): string {
    return buildMcpToolsPrompt(this.mcpManager);
  }

  /**
   * Get saved credentials prompt for system instructions
   * Credentials are provided directly to the agent for automated login
   */
  private getCredentialsPrompt(): string {
    try {
      const credentials = credentialsStore.getAll();
      if (credentials.length === 0) {
        return '';
      }

      // Group credentials by type
      const emailCredentials = credentials.filter(c => c.type === 'email');
      const websiteCredentials = credentials.filter(c => c.type === 'website');
      const apiCredentials = credentials.filter(c => c.type === 'api');
      const otherCredentials = credentials.filter(c => c.type === 'other');

      // Format credentials with actual password for agent use
      const formatCredential = (c: UserCredential) => {
        const lines = [`- **${c.name}**${c.service ? ` (${c.service})` : ''}`];
        lines.push(`  - Username/Email: \`${c.username}\``);
        lines.push(`  - Password: \`${c.password}\``);
        if (c.url) lines.push(`  - URL: ${c.url}`);
        if (c.notes) lines.push(`  - Notes: ${c.notes}`);
        return lines.join('\n');
      };

      let sections: string[] = [];
      
      if (emailCredentials.length > 0) {
        sections.push(`**Email Accounts (${emailCredentials.length}):**\n${emailCredentials.map(formatCredential).join('\n\n')}`);
      }
      if (websiteCredentials.length > 0) {
        sections.push(`**Website Accounts (${websiteCredentials.length}):**\n${websiteCredentials.map(formatCredential).join('\n\n')}`);
      }
      if (apiCredentials.length > 0) {
        sections.push(`**API Keys (${apiCredentials.length}):**\n${apiCredentials.map(formatCredential).join('\n\n')}`);
      }
      if (otherCredentials.length > 0) {
        sections.push(`**Other Credentials (${otherCredentials.length}):**\n${otherCredentials.map(formatCredential).join('\n\n')}`);
      }

      return `
<saved_credentials>
The user has saved ${credentials.length} credential(s) for automated login. Use these credentials when the user asks you to access their accounts.

${sections.join('\n\n')}

**IMPORTANT - How to use credentials:**
- Use these credentials directly when logging into websites or services
- For email access (e.g., Gmail), use the Chrome MCP tools to navigate to the login page and enter the credentials
- NEVER display, share, or echo passwords in your responses to the user
- Only use credentials for tasks the user explicitly requests
- If login fails, inform the user but do not expose the password
</saved_credentials>
`;
    } catch (error) {
      logError('[AgentRunner] Failed to get credentials prompt:', error);
      return '';
    }
  }

  /**
   * Get the built-in skills directory (shipped with the app)
   */
  private getBuiltinSkillsPath(): string {
    // In development, skills are in the project's .claude/skills directory
    // In production, they're bundled with the app (in app.asar.unpacked for asarUnpack files)
    const appPath = app.getAppPath();
    
    // For asarUnpack files, replace .asar with .asar.unpacked
    const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');
    
    const possiblePaths = [
      // Development: relative to this file
      path.join(__dirname, '..', '..', '..', '.claude', 'skills'),
      // Production: in app.asar.unpacked (for asarUnpack files)
      path.join(unpackedPath, '.claude', 'skills'),
      // Fallback: in app resources (if not unpacked)
      path.join(appPath, '.claude', 'skills'),
      // Alternative: in resources folder
      path.join(process.resourcesPath || '', 'skills'),
    ];
    
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        log('[ClaudeAgentRunner] Found built-in skills at:', p);
        return p;
      }
    }
    
    logWarn('[ClaudeAgentRunner] No built-in skills directory found');
    return '';
  }

  private getAppClaudeDir(): string {
    return path.join(app.getPath('userData'), 'claude');
  }

  private getRuntimeSkillsDir(): string {
    return path.join(this.getAppClaudeDir(), 'skills');
  }

  private getConfiguredGlobalSkillsDir(): string {
    const configuredPath = (configStore.get('globalSkillsPath') || '').trim();
    if (!configuredPath) {
      return this.getRuntimeSkillsDir();
    }

    const resolvedPath = path.resolve(configuredPath);
    try {
      if (!fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
      }
      if (fs.statSync(resolvedPath).isDirectory()) {
        return resolvedPath;
      }
      logWarn('[ClaudeAgentRunner] Configured skills path is not a directory, fallback to runtime path:', resolvedPath);
    } catch (error) {
      logWarn('[ClaudeAgentRunner] Configured skills path is unavailable, fallback to runtime path:', resolvedPath, error);
    }

    return this.getRuntimeSkillsDir();
  }

  private getUserClaudeSkillsDir(): string {
    return path.join(app.getPath('home'), '.claude', 'skills');
  }

  private syncUserSkillsToAppDir(appSkillsDir: string): void {
    const userSkillsDir = this.getUserClaudeSkillsDir();
    if (!fs.existsSync(userSkillsDir)) {
      return;
    }

    const entries = fs.readdirSync(userSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(userSkillsDir, entry.name);
      const targetPath = path.join(appSkillsDir, entry.name);

      if (fs.existsSync(targetPath)) {
        try {
          const stat = fs.lstatSync(targetPath);
          if (!stat.isSymbolicLink()) {
            continue;
          }
          fs.unlinkSync(targetPath);
        } catch {
          continue;
        }
      }

      try {
        fs.symlinkSync(sourcePath, targetPath, 'dir');
      } catch (err) {
        try {
          this.copyDirectorySync(sourcePath, targetPath);
        } catch (copyErr) {
          logWarn('[ClaudeAgentRunner] Failed to import user skill:', entry.name, copyErr);
        }
      }
    }
  }

  private syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir: string): void {
    const configuredSkillsDir = this.getConfiguredGlobalSkillsDir();
    if (configuredSkillsDir === runtimeSkillsDir) {
      return;
    }
    if (!fs.existsSync(configuredSkillsDir) || !fs.statSync(configuredSkillsDir).isDirectory()) {
      return;
    }

    const entries = fs.readdirSync(configuredSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(configuredSkillsDir, entry.name);
      const targetPath = path.join(runtimeSkillsDir, entry.name);
      try {
        if (fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        }
        fs.symlinkSync(sourcePath, targetPath, 'dir');
      } catch (err) {
        try {
          this.copyDirectorySync(sourcePath, targetPath);
        } catch (copyErr) {
          logWarn('[ClaudeAgentRunner] Failed to sync configured skill:', entry.name, copyErr);
        }
      }
    }
  }

  private copyDirectorySync(source: string, target: string): void {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const entries = fs.readdirSync(source);
    for (const entry of entries) {
      const sourcePath = path.join(source, entry);
      const targetPath = path.join(target, entry);
      const stat = fs.statSync(sourcePath);

      if (stat.isDirectory()) {
        this.copyDirectorySync(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  /**
   * Scan for available skills and return formatted list for system prompt
   */
  private getAvailableSkillsPrompt(workingDir?: string): string {
    const skills: { name: string; description: string; skillMdPath: string }[] = [];
    
    // 1. Check built-in skills (highest priority for reading)
    const builtinSkillsPath = this.getBuiltinSkillsPath();
    if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
      try {
        const dirs = fs.readdirSync(builtinSkillsPath, { withFileTypes: true });
        for (const dir of dirs) {
          if (dir.isDirectory()) {
            const skillMdPath = path.join(builtinSkillsPath, dir.name, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
              // Try to read description from SKILL.md frontmatter
              let description = `Skill for ${dir.name} file operations`;
              try {
                const content = fs.readFileSync(skillMdPath, 'utf-8');
                const descMatch = content.match(/description:\s*["']?([^"'\n]+)["']?/);
                if (descMatch) {
                  description = descMatch[1];
                }
              } catch (e) { /* ignore */ }
              
              skills.push({
                name: dir.name,
                description,
                skillMdPath,
              });
            }
          }
        }
      } catch (e) {
        logError('[ClaudeAgentRunner] Error scanning built-in skills:', e);
      }
    }
    
    // 2. Check global skills (configured skills directory)
    const globalSkillsPath = this.getConfiguredGlobalSkillsDir();
    if (fs.existsSync(globalSkillsPath)) {
      try {
        const dirs = fs.readdirSync(globalSkillsPath, { withFileTypes: true });
        for (const dir of dirs) {
          if (dir.isDirectory()) {
            const skillMdPath = path.join(globalSkillsPath, dir.name, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
              // Global skills can override built-in but not project-level
              const existingIdx = skills.findIndex(s => s.name === dir.name);
              let description = `User skill for ${dir.name}`;
              try {
                const content = fs.readFileSync(skillMdPath, 'utf-8');
                const descMatch = content.match(/description:\s*["']?([^"'\n]+)["']?/);
                if (descMatch) {
                  description = descMatch[1];
                }
              } catch (e) { /* ignore */ }

              const skill = { name: dir.name, description, skillMdPath };
              if (existingIdx >= 0) {
                skills[existingIdx] = skill;
              } else {
                skills.push(skill);
              }
            }
          }
        }
      } catch (e) {
        logError('[ClaudeAgentRunner] Error scanning global skills:', e);
      }
    }

    // 3. Check project-level skills (in working directory)
    if (workingDir) {
      const projectSkillsPaths = [
        path.join(workingDir, '.claude', 'skills'),
        path.join(workingDir, '.skills'),
        path.join(workingDir, 'skills'),
      ];

      for (const skillsDir of projectSkillsPaths) {
        if (fs.existsSync(skillsDir)) {
          try {
            const dirs = fs.readdirSync(skillsDir, { withFileTypes: true });
            for (const dir of dirs) {
              if (dir.isDirectory()) {
                const skillMdPath = path.join(skillsDir, dir.name, 'SKILL.md');
                if (fs.existsSync(skillMdPath)) {
                  // Project skills can override built-in and global
                  const existingIdx = skills.findIndex(s => s.name === dir.name);
                  let description = `Project skill for ${dir.name}`;
                  try {
                    const content = fs.readFileSync(skillMdPath, 'utf-8');
                    const descMatch = content.match(/description:\s*["']?([^"'\n]+)["']?/);
                    if (descMatch) {
                      description = descMatch[1];
                    }
                  } catch (e) { /* ignore */ }

                  const skill = { name: dir.name, description, skillMdPath };
                  if (existingIdx >= 0) {
                    skills[existingIdx] = skill;
                  } else {
                    skills.push(skill);
                  }
                }
              }
            }
          } catch (e) { /* ignore */ }
        }
      }
    }
    
    if (skills.length === 0) {
      return '<available_skills>\nNo skills available.\n</available_skills>';
    }
    
    // Format the skills list
    const skillsList = skills.map(s => 
      `- **${s.name}**: ${s.description}\n  SKILL.md path: ${s.skillMdPath}`
    ).join('\n');
    
    return `<available_skills>
The following skills are available. **CRITICAL**: Before starting any task that involves creating or editing files of these types, you MUST first read the corresponding SKILL.md file using the Read tool:

${skillsList}

**How to use skills:**
1. Identify which skill is relevant to your task (e.g., "pptx" for PowerPoint, "docx" for Word, "pdf" for PDF)
2. Use the Read tool to read the SKILL.md file at the path shown above
3. Follow the instructions in the SKILL.md file exactly
4. The skills contain proven workflows that produce high-quality results

**Example**: If the user asks to create a PowerPoint presentation:
\`\`\`
Read the file: ${skills.find(s => s.name === 'pptx')?.skillMdPath || '[pptx skill path]'}
\`\`\`
Then follow the workflow described in that file.
</available_skills>`;
  }

  constructor(
    options: AgentRunnerOptions,
    pathResolver: PathResolver,
    mcpManager?: MCPManager,
    pluginRuntimeService?: PluginRuntimeService
  ) {
    this.sendToRenderer = options.sendToRenderer;
    this.saveMessage = options.saveMessage;
    this.pathResolver = pathResolver;
    this.mcpManager = mcpManager;
    this.pluginRuntimeService = pluginRuntimeService;
    
    log('[ClaudeAgentRunner] Initialized with claude-agent-sdk');
    log('[ClaudeAgentRunner] Skills enabled: settingSources=[user, project], Skill tool enabled');
    if (mcpManager) {
      log('[ClaudeAgentRunner] MCP support enabled');
    }
  }
  
  /**
   * Resolve current model from runtime config/env.
   * 优先使用配置中的 model，避免读取过期的 process.env 导致模型不一致。
   */
  private getCurrentModel(runtimeEnv: NodeJS.ProcessEnv, preferredModel?: string): string {
    const routeModel = preferredModel?.trim();
    const configuredModel = configStore.get('model')?.trim();
    const model = routeModel
      || configuredModel
      || runtimeEnv.CLAUDE_MODEL
      || runtimeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL
      || 'anthropic/claude-sonnet-4';
    log('[ClaudeAgentRunner] Current model:', model);
    log('[ClaudeAgentRunner] Model source:', routeModel ? 'runtimeRoute.model' : configuredModel ? 'configStore.model' : 'runtime environment');
    log('[ClaudeAgentRunner] ANTHROPIC_DEFAULT_SONNET_MODEL:', runtimeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL || '(not set)');
    return model;
  }

  // Handle user's answer to AskUserQuestion
  handleQuestionResponse(questionId: string, answer: string): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (pending) {
      log(`[ClaudeAgentRunner] Question ${questionId} answered:`, answer);
      pending.resolve(answer);
      this.pendingQuestions.delete(questionId);
      return true;
    } else {
      logWarn(`[ClaudeAgentRunner] No pending question found for ID: ${questionId}`);
      return false;
    }
  }

  async run(session: Session, prompt: string, existingMessages: Message[]): Promise<void> {
    const startTime = Date.now();
    const logTiming = (label: string) => {
      log(`[TIMING] ${label}: ${Date.now() - startTime}ms`);
    };
    
    logTiming('run() started');
    
    const controller = new AbortController();
    try {
      // SDK 会在同一 AbortSignal 上挂载较多监听器，放开上限避免无意义告警干扰排错。
      setMaxListeners(0, controller.signal);
    } catch {
      // 旧运行时不支持 EventTarget 调整监听上限时忽略即可。
    }
    this.activeControllers.set(session.id, controller);

    // Sandbox isolation state (defined outside try for finally access)
    let sandboxPath: string | null = null;
    let useSandboxIsolation = false;
    let proxyLeaseSignature: string | null = null;
    
    // Track last executed tool for completion message generation
    let lastExecutedToolName: string | null = null;
    
    // Helper to convert real sandbox paths back to virtual workspace paths in output
    const sanitizeOutputPaths = (content: string): string => {
      if (!sandboxPath || !useSandboxIsolation) return content;
      // Replace real sandbox path with virtual workspace path
      return content.replace(new RegExp(sandboxPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), VIRTUAL_WORKSPACE_PATH);
    };

    try {
      this.pathResolver.registerSession(session.id, session.mountedPaths);
      logTiming('pathResolver.registerSession');

      // Note: User message is now added by the frontend immediately for better UX
      // No need to send it again from backend

      // Send initial thinking trace
      const thinkingStepId = uuidv4();
      this.sendTraceStep(session.id, {
        id: thinkingStepId,
        type: 'thinking',
        status: 'running',
        title: 'Processing request...',
        timestamp: Date.now(),
      });
      logTiming('sendTraceStep (thinking)');

      // Use session's cwd - each session has its own working directory
      const workingDir = session.cwd || undefined;
      log('[ClaudeAgentRunner] Working directory:', workingDir || '(none)');

      // Initialize sandbox sync if WSL mode is active
      const sandbox = getSandboxAdapter();

      if (sandbox.isWSL && sandbox.wslStatus?.distro && workingDir) {
        log('[ClaudeAgentRunner] WSL mode active, initializing sandbox sync...');
        
        // Only show sync UI for new sessions (first message)
        const isNewSession = !SandboxSync.hasSession(session.id);
        
        if (isNewSession) {
          // Notify UI: syncing files (only for new sessions)
          this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_files',
              message: 'Syncing files to sandbox...',
              detail: 'Copying project files to isolated WSL environment',
            },
          });
        }
        
        const syncResult = await SandboxSync.initSync(
          workingDir,
          session.id,
          sandbox.wslStatus.distro
        );

        if (syncResult.success) {
          sandboxPath = syncResult.sandboxPath;
          useSandboxIsolation = true;
          log(`[ClaudeAgentRunner] Sandbox initialized: ${sandboxPath}`);
          log(`[ClaudeAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`);
          
          if (isNewSession) {
            // Update UI with file count (only for new sessions)
            this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_skills',
              message: 'Configuring skills...',
              detail: 'Copying built-in skills to sandbox',
              fileCount: syncResult.fileCount,
              totalSize: syncResult.totalSize,
            },
          });
          }

          // Copy skills to sandbox ~/.claude/skills/
          const builtinSkillsPath = this.getBuiltinSkillsPath();
          try {
            const distro = sandbox.wslStatus!.distro!;
            const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

            // Create .claude/skills directory in sandbox
            const { execSync } = require('child_process');
            execSync(`wsl -d ${distro} -e mkdir -p "${sandboxSkillsPath}"`, {
              encoding: 'utf-8',
              timeout: 10000
            });

            if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
              // Use rsync to recursively copy all skills (much faster and handles subdirectories)
              const wslSourcePath = pathConverter.toWSL(builtinSkillsPath);
              const rsyncCmd = `rsync -av "${wslSourcePath}/" "${sandboxSkillsPath}/"`;
              log(`[ClaudeAgentRunner] Copying skills with rsync: ${rsyncCmd}`);

              execSync(`wsl -d ${distro} -e bash -c "${rsyncCmd}"`, {
                encoding: 'utf-8',
                timeout: 120000  // 2 min timeout for large skill directories
              });
            }

            const appSkillsDir = this.getRuntimeSkillsDir();
            if (!fs.existsSync(appSkillsDir)) {
              fs.mkdirSync(appSkillsDir, { recursive: true });
            }
            this.syncUserSkillsToAppDir(appSkillsDir);
            this.syncConfiguredSkillsToRuntimeDir(appSkillsDir);

            if (fs.existsSync(appSkillsDir)) {
              const wslSourcePath = pathConverter.toWSL(appSkillsDir);
              const rsyncCmd = `rsync -avL "${wslSourcePath}/" "${sandboxSkillsPath}/"`;
              log(`[ClaudeAgentRunner] Copying app skills with rsync: ${rsyncCmd}`);

              execSync(`wsl -d ${distro} -e bash -c "${rsyncCmd}"`, {
                encoding: 'utf-8',
                timeout: 120000  // 2 min timeout for large skill directories
              });
            }

            // List copied skills for verification
            const copiedSkills = execSync(`wsl -d ${distro} -e ls "${sandboxSkillsPath}"`, {
              encoding: 'utf-8',
              timeout: 10000
            }).trim().split('\n').filter(Boolean);

            log(`[ClaudeAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
            log(`[ClaudeAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
          } catch (error) {
            logError('[ClaudeAgentRunner] Failed to copy skills to sandbox:', error);
          }
          
          if (isNewSession) {
            // Notify UI: sync complete (only for new sessions)
            this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'ready',
              message: 'Sandbox ready',
              detail: `Synced ${syncResult.fileCount} files`,
              fileCount: syncResult.fileCount,
              totalSize: syncResult.totalSize,
            },
          });
          }
        } else {
          logError('[ClaudeAgentRunner] Sandbox sync failed:', syncResult.error);
          log('[ClaudeAgentRunner] Falling back to /mnt/ access (less secure)');
          
          if (isNewSession) {
            // Notify UI: error (only for new sessions)
            this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'error',
              message: 'Sandbox sync failed',
              detail: 'Falling back to direct access mode (less secure)',
            },
          });
          }
        }
      }

      // Initialize sandbox sync if Lima mode is active
      if (sandbox.isLima && sandbox.limaStatus?.instanceRunning && workingDir) {
        log('[ClaudeAgentRunner] Lima mode active, initializing sandbox sync...');
        
        const { LimaSync } = await import('../sandbox/lima-sync');
        
        // Only show sync UI for new sessions (first message)
        const isNewLimaSession = !LimaSync.hasSession(session.id);
        
        if (isNewLimaSession) {
          // Notify UI: syncing files (only for new sessions)
          this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_files',
              message: 'Syncing files to sandbox...',
              detail: 'Copying project files to isolated Lima environment',
            },
          });
        }
        
        const syncResult = await LimaSync.initSync(
          workingDir,
          session.id
        );

        if (syncResult.success) {
          sandboxPath = syncResult.sandboxPath;
          useSandboxIsolation = true;
          log(`[ClaudeAgentRunner] Sandbox initialized: ${sandboxPath}`);
          log(`[ClaudeAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`);
          
          if (isNewLimaSession) {
            // Update UI with file count (only for new sessions)
            this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_skills',
              message: 'Configuring skills...',
              detail: 'Copying built-in skills to sandbox',
              fileCount: syncResult.fileCount,
              totalSize: syncResult.totalSize,
            },
          });
          }

          // Copy skills to sandbox ~/.claude/skills/
          const builtinSkillsPath = this.getBuiltinSkillsPath();
          try {
            const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

            // Create .claude/skills directory in sandbox
            const { execSync } = require('child_process');
            execSync(`limactl shell claude-sandbox -- mkdir -p "${sandboxSkillsPath}"`, {
              encoding: 'utf-8',
              timeout: 10000
            });

            if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
              // Use rsync to recursively copy all skills (much faster and handles subdirectories)
              // Lima mounts /Users directly, so paths are the same
              const rsyncCmd = `rsync -av "${builtinSkillsPath}/" "${sandboxSkillsPath}/"`;
              log(`[ClaudeAgentRunner] Copying skills with rsync: ${rsyncCmd}`);

              execSync(`limactl shell claude-sandbox -- bash -c "${rsyncCmd.replace(/"/g, '\\"')}"`, {
                encoding: 'utf-8',
                timeout: 120000  // 2 min timeout for large skill directories
              });
            }

            const appSkillsDir = this.getRuntimeSkillsDir();
            if (!fs.existsSync(appSkillsDir)) {
              fs.mkdirSync(appSkillsDir, { recursive: true });
            }
            this.syncUserSkillsToAppDir(appSkillsDir);
            this.syncConfiguredSkillsToRuntimeDir(appSkillsDir);

            if (fs.existsSync(appSkillsDir)) {
              const rsyncCmd = `rsync -avL "${appSkillsDir}/" "${sandboxSkillsPath}/"`;
              log(`[ClaudeAgentRunner] Copying app skills with rsync: ${rsyncCmd}`);

              execSync(`limactl shell claude-sandbox -- bash -c "${rsyncCmd.replace(/"/g, '\\"')}"`, {
                encoding: 'utf-8',
                timeout: 120000  // 2 min timeout for large skill directories
              });
            }

            // List copied skills for verification
            const copiedSkills = execSync(`limactl shell claude-sandbox -- ls "${sandboxSkillsPath}"`, {
              encoding: 'utf-8',
              timeout: 10000
            }).trim().split('\n').filter(Boolean);

            log(`[ClaudeAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
            log(`[ClaudeAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
          } catch (error) {
            logError('[ClaudeAgentRunner] Failed to copy skills to sandbox:', error);
          }
          
          if (isNewLimaSession) {
            // Notify UI: sync complete (only for new sessions)
            this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'ready',
              message: 'Sandbox ready',
              detail: `Synced ${syncResult.fileCount} files`,
              fileCount: syncResult.fileCount,
              totalSize: syncResult.totalSize,
            },
          });
          }
        } else {
          logError('[ClaudeAgentRunner] Sandbox sync failed:', syncResult.error);
          log('[ClaudeAgentRunner] Falling back to direct access (less secure)');
          
          if (isNewLimaSession) {
            // Notify UI: error (only for new sessions)
            this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'error',
              message: 'Sandbox sync failed',
              detail: 'Falling back to direct access mode (less secure)',
            },
          });
          }
        }
      }

      // Check if current user message includes images
      // Images need to be passed via AsyncIterable<SDKUserMessage>, not string prompt
      const lastUserMessage = existingMessages.length > 0
        ? existingMessages[existingMessages.length - 1]
        : null;

      log('[ClaudeAgentRunner] Total messages:', existingMessages.length);
      log('[ClaudeAgentRunner] Last message:', lastUserMessage ? {
        role: lastUserMessage.role,
        contentTypes: lastUserMessage.content.map((c: any) => c.type),
        contentCount: lastUserMessage.content.length,
      } : 'none');

      let hasImages = lastUserMessage?.content.some((c: any) => c.type === 'image') || false;

      if (hasImages) {
        log('[ClaudeAgentRunner] User message contains images, will use AsyncIterable format');
      } else {
        log('[ClaudeAgentRunner] No images detected in last message');
      }

      logTiming('before resolveClaudeCodeExecutablePath');
      
      // Use query from @anthropic-ai/claude-agent-sdk
      const resolvedClaudeCode = resolveClaudeCodeExecutablePath({
        preferredPath: configStore.get('claudeCodePath')?.trim(),
        env: process.env,
      });
      const claudeCodePath = resolvedClaudeCode?.executablePath ?? '';
      log('[ClaudeAgentRunner] Claude Code path:', claudeCodePath);
      if (resolvedClaudeCode?.source) {
        log('[ClaudeAgentRunner] Claude Code path source:', resolvedClaudeCode.source);
      }
      logTiming('after resolveClaudeCodeExecutablePath');
      
      // Check if Claude Code is found
      if (!claudeCodePath || !fs.existsSync(claudeCodePath)) {
        const errorMsg = !claudeCodePath 
          ? 'Claude Code 未找到。请先安装: npm install -g @anthropic-ai/claude-code，或在设置中手动指定路径。'
          : `Claude Code 路径不存在: ${claudeCodePath}。请检查路径或在设置中重新配置。`;
        logError('[ClaudeAgentRunner]', errorMsg);
        this.sendToRenderer({
          type: 'error',
          payload: { message: errorMsg },
        });
        throw new Error(errorMsg);
      }

      // SANDBOX: Path validation function with whitelist for skills directories
      const builtinSkillsPathForValidation = this.getBuiltinSkillsPath();
      const appClaudeDirForValidation = this.getAppClaudeDir();
      const configuredSkillsPathForValidation = this.getConfiguredGlobalSkillsDir();
      
      // @ts-ignore - Reserved for future use
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const isPathInsideWorkspace = (targetPath: string): boolean => {
        if (!targetPath) return true;
        
        // Normalize path for comparison
        const normalizedTarget = path.normalize(targetPath);
        
        // WHITELIST: Allow access to skills directories (read-only for AI)
        // This allows AI to read SKILL.md files from built-in and app-level skills
        const whitelistedPaths = [
          builtinSkillsPathForValidation,  // Built-in skills (shipped with app)
          appClaudeDirForValidation,        // App Claude config dir (includes user skills)
          configuredSkillsPathForValidation,
        ].filter(Boolean) as string[];
        
        for (const whitelistedPath of whitelistedPaths) {
          const normalizedWhitelist = path.normalize(whitelistedPath);
          if (normalizedTarget.toLowerCase().startsWith(normalizedWhitelist.toLowerCase())) {
            log(`[Sandbox] WHITELIST: Path "${targetPath}" is in whitelisted skills directory`);
            return true;
          }
        }
        
        // If no working directory is set, deny all file access (except whitelisted)
        if (!workingDir) {
          return false;
        }
        
        const normalizedWorkdir = path.normalize(workingDir);
        
        // Check if absolute path
        const isAbsolute = path.isAbsolute(normalizedTarget) || /^[A-Za-z]:/.test(normalizedTarget);
        
        if (isAbsolute) {
          // Absolute path must be inside workingDir
          return normalizedTarget.toLowerCase().startsWith(normalizedWorkdir.toLowerCase());
        }
        
        // Relative path - check for .. traversal
        if (normalizedTarget.includes('..')) {
          const resolved = path.resolve(workingDir, normalizedTarget);
          return resolved.toLowerCase().startsWith(normalizedWorkdir.toLowerCase());
        }
        
        return true; // Relative path without .. is OK
      };

      // Extract paths from tool input
      const extractPathsFromInput = (toolName: string, input: Record<string, unknown>): string[] => {
        const paths: string[] = [];
        
        // File tools
        if (input.path) paths.push(String(input.path));
        if (input.file_path) paths.push(String(input.file_path));
        if (input.filePath) paths.push(String(input.filePath));
        if (input.directory) paths.push(String(input.directory));
        
        // Bash command - extract paths from command string
        if (toolName === 'Bash' && input.command) {
          const cmd = String(input.command);
          
          // Extract Windows absolute paths (C:\... or D:\...)
          const winPaths = cmd.match(/[A-Za-z]:[\\\/][^\s;|&"'<>]*/g) || [];
          paths.push(...winPaths);
          
          // Extract quoted paths
          const quotedPaths = cmd.match(/"([^"]+)"/g) || [];
          quotedPaths.forEach(p => paths.push(p.replace(/"/g, '')));
        }
        
        return paths;
      };

      // Build options with resume support and SANDBOX via canUseTool
      const resumeId = this.sdkSessions.get(session.id);
      
      const supportsImageInputs = (model: string | undefined, baseUrl: string | undefined): boolean => {
        const modelLower = (model || '').toLowerCase();
        const baseLower = (baseUrl || '').toLowerCase();

        if (baseLower.includes('deepseek')) return false;
        if (baseLower.includes('open.bigmodel.cn')) return false;
        if (!modelLower) return false;

        const knownImageCapableModel = (
          modelLower.includes('claude-3') ||
          modelLower.includes('claude-3.5') ||
          modelLower.includes('claude-3-5') ||
          modelLower.includes('claude-4') ||
          modelLower.includes('claude-sonnet') ||
          modelLower.includes('claude-opus') ||
          modelLower.includes('claude-haiku') ||
          modelLower.includes('gpt-4o') ||
          modelLower.includes('gpt-4.1') ||
          modelLower.includes('gpt-5') ||
          modelLower.includes('o1') ||
          modelLower.includes('o3') ||
          modelLower.includes('gemini')
        );

        if (knownImageCapableModel) {
          return true;
        }

        // openai/* 与 gemini/* 前缀模型默认按可图像输入处理
        if (modelLower.startsWith('openai/') || modelLower.startsWith('gemini/')) {
          return true;
        }

        return false;
      };

      // Use app-specific Claude config directory to avoid conflicts with user settings
      // SDK uses CLAUDE_CONFIG_DIR to locate skills
      const userClaudeDir = this.getAppClaudeDir();

      // Ensure app Claude config directory exists
      if (!fs.existsSync(userClaudeDir)) {
        fs.mkdirSync(userClaudeDir, { recursive: true });
      }

      // Ensure app Claude skills directory exists
      const appSkillsDir = this.getRuntimeSkillsDir();
      if (!fs.existsSync(appSkillsDir)) {
        fs.mkdirSync(appSkillsDir, { recursive: true });
      }

      // Copy built-in skills to app Claude skills directory if they don't exist
      const builtinSkillsPath = this.getBuiltinSkillsPath();
      if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
        const builtinSkills = fs.readdirSync(builtinSkillsPath);
        for (const skillName of builtinSkills) {
          const builtinSkillPath = path.join(builtinSkillsPath, skillName);
          const userSkillPath = path.join(appSkillsDir, skillName);

          // Only copy if it's a directory and doesn't exist in app directory
          if (fs.statSync(builtinSkillPath).isDirectory() && !fs.existsSync(userSkillPath)) {
            // Create symlink instead of copying to save space and allow updates
            try {
              fs.symlinkSync(builtinSkillPath, userSkillPath, 'dir');
              log(`[ClaudeAgentRunner] Linked built-in skill: ${skillName}`);
            } catch (err) {
              // If symlink fails (e.g., on Windows without permissions), copy the directory
              logWarn(`[ClaudeAgentRunner] Failed to symlink ${skillName}, copying instead:`, err);
              // We'll skip copying for now to keep it simple
            }
          }
        }
      }

      this.syncUserSkillsToAppDir(appSkillsDir);
      this.syncConfiguredSkillsToRuntimeDir(appSkillsDir);

      // Build available skills section dynamically
      const availableSkillsPrompt = this.getAvailableSkillsPrompt(workingDir);

      log('[ClaudeAgentRunner] App claude dir:', userClaudeDir);
      log('[ClaudeAgentRunner] User working directory:', workingDir);

      logTiming('before getShellEnvironment');

      // Get shell environment with proper PATH (node, npm, etc.)
      // GUI apps on macOS don't inherit shell PATH, so we need to extract it
      const shellEnv = getShellEnvironment();
      logTiming('after getShellEnvironment');

      const runtimeConfig = configStore.getAll();
      const unifiedSdkEnabled = shouldUseUnifiedClaudeSdk(runtimeConfig);
      const unifiedProxyEnabled = shouldUseUnifiedClaudeProxy(runtimeConfig);

      let runtimeConfigForSdk = runtimeConfig;
      let envOverrides = getClaudeEnvOverrides(runtimeConfigForSdk);
      if (unifiedProxyEnabled) {
        const route = resolveUnifiedGatewayProfile(runtimeConfig);
        if (!route.ok || !route.profile) {
          const reason = route.reason || 'unknown';
          if (reason === 'missing_key') {
            throw new Error('proxy_upstream_auth_failed:missing_key');
          }
          if (reason === 'missing_base_url') {
            throw new Error('proxy_upstream_not_found:missing_base_url');
          }
          throw new Error(`proxy_upstream_not_found:${reason}`);
        }
        const proxyRuntime = await claudeProxyManager.ensureReady(route.profile);
        claudeProxyManager.retain(proxyRuntime.signature);
        proxyLeaseSignature = proxyRuntime.signature;
        runtimeConfigForSdk = {
          ...runtimeConfig,
          model: route.profile.model,
        };
        if (runtimeConfigForSdk.model !== runtimeConfig.model) {
          log('[ClaudeAgentRunner] Normalized model for proxy route', {
            originalModel: runtimeConfig.model,
            normalizedModel: runtimeConfigForSdk.model,
          });
        }
        envOverrides = getClaudeEnvOverrides(runtimeConfigForSdk, {
          proxyBaseUrl: proxyRuntime.baseUrl,
          proxyApiKey: proxyRuntime.sdkApiKey,
        });
      }
      // 构建运行环境：shell 环境 + 配置覆盖 + CLAUDE_CONFIG_DIR
      const envWithSkills: NodeJS.ProcessEnv = {
        ...buildClaudeEnv(shellEnv, envOverrides),
        CLAUDE_CONFIG_DIR: userClaudeDir,
      };
      const currentModel = this.getCurrentModel(envWithSkills, runtimeConfigForSdk.model);

      log('[ClaudeAgentRunner] CLAUDE_CONFIG_DIR:', userClaudeDir);
      log('[ClaudeAgentRunner] PATH in env:', (envWithSkills.PATH || '').substring(0, 200) + '...');
      log('[ClaudeAgentRunner] Auth env summary:', {
        provider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
        unifiedProxyEnabled,
        anthropicApiKeySet: Boolean(envWithSkills.ANTHROPIC_API_KEY),
        anthropicAuthTokenSet: Boolean(envWithSkills.ANTHROPIC_AUTH_TOKEN),
        anthropicBaseUrl: envWithSkills.ANTHROPIC_BASE_URL || '(default)',
        openaiApiKeySet: Boolean(envWithSkills.OPENAI_API_KEY),
        openaiBaseUrl: envWithSkills.OPENAI_BASE_URL || '(default)',
        openaiCodexOAuth: envWithSkills.OPENAI_CODEX_OAUTH || '(not set)',
      });

      const imageCapable = supportsImageInputs(currentModel, envWithSkills.ANTHROPIC_BASE_URL);
      if (hasImages && !imageCapable) {
        logWarn('[ClaudeAgentRunner] Image content detected but model/provider does not support images; dropping image blocks');
        hasImages = false;
      }

      // Build conversation context for text-only history
      let contextualPrompt = prompt;
      const conversationMessages = existingMessages
        .filter(msg => msg.role === 'user' || msg.role === 'assistant');
      const historyMessages = (
        conversationMessages.length > 0
          && conversationMessages[conversationMessages.length - 1]?.role === 'user'
      )
        ? conversationMessages.slice(0, -1)
        : conversationMessages;
      const historyItems = historyMessages
        .map(msg => {
          const textContent = msg.content
            .filter(c => c.type === 'text')
            .map(c => (c as any).text)
            .join('\n');
          return `${msg.role === 'user' ? 'Human' : 'Assistant'}: ${textContent}`;
        });

      if (historyItems.length > 0 && !hasImages) {
        contextualPrompt = `${historyItems.join('\n')}\nHuman: ${prompt}\nAssistant:`;
        log('[ClaudeAgentRunner] Including', historyItems.length, 'history messages in context');
      }
      
      logTiming('before building MCP servers config');
      
      // Build MCP servers configuration for SDK
      // IMPORTANT: SDK uses tool names in format: mcp__<ServerKey>__<toolName>
      const mcpServers: Record<string, any> = {};
      if (this.mcpManager) {
        const serverStatuses = this.mcpManager.getServerStatus();
        const connectedServers = serverStatuses.filter((s) => s.connected);
        log('[ClaudeAgentRunner] MCP server statuses:', safeStringify(serverStatuses));
        log('[ClaudeAgentRunner] Connected MCP servers:', connectedServers.length);

        let allConfigs: ReturnType<typeof mcpConfigStore.getEnabledServers> = [];
        try {
          allConfigs = mcpConfigStore.getEnabledServers();
          log('[ClaudeAgentRunner] Enabled MCP configs:', allConfigs.map((c) => c.name));
        } catch (error) {
          logError(
            '[ClaudeAgentRunner] Failed to read enabled MCP configs; continuing without MCP overrides',
            error
          );
          allConfigs = [];
        }

        // 获取 STDIO 服务的内置 node/npx 路径
        const getBundledNodePaths = (): { node: string; npx: string } | null => {
          const platform = process.platform;
          const arch = process.arch;

          let resourcesPath: string;
          if (process.env.NODE_ENV === 'development') {
            const projectRoot = path.join(__dirname, '..', '..');
            resourcesPath = path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`);
          } else {
            resourcesPath = path.join(process.resourcesPath, 'node');
          }

          const binDir = platform === 'win32' ? resourcesPath : path.join(resourcesPath, 'bin');
          const nodeExe = platform === 'win32' ? 'node.exe' : 'node';
          const npxExe = platform === 'win32' ? 'npx.cmd' : 'npx';
          const nodePath = path.join(binDir, nodeExe);
          const npxPath = path.join(binDir, npxExe);

          if (fs.existsSync(nodePath) && fs.existsSync(npxPath)) {
            return { node: nodePath, npx: npxPath };
          }
          return null;
        };

        const bundledNodePaths = getBundledNodePaths();
        const bundledNpx = bundledNodePaths?.npx ?? null;

        for (const config of allConfigs) {
          try {
            // Use a simpler key without spaces to avoid issues
            const serverKey = config.name;

            if (config.type === 'stdio') {
              // 当命令是 npx 或 node 时优先使用内置路径
              const command = (config.command === 'npx' && bundledNpx)
                ? bundledNpx
                : (config.command === 'node' && bundledNodePaths ? bundledNodePaths.node : config.command);

              // 使用内置 npx/node 时，将内置 node bin 注入 PATH
              let serverEnv = { ...config.env };
              if (bundledNodePaths && (config.command === 'npx' || config.command === 'node')) {
                const nodeBinDir = path.dirname(bundledNodePaths.node);
                const currentPath = process.env.PATH || '';
                // Prepend bundled node bin to PATH so npx can find node
                serverEnv.PATH = `${nodeBinDir}${path.delimiter}${currentPath}`;
                log(`[ClaudeAgentRunner]   Added bundled node bin to PATH: ${nodeBinDir}`);
              }

              if (!imageCapable) {
                serverEnv.OPEN_COWORK_DISABLE_IMAGE_TOOL_OUTPUT = '1';
              }

              // Resolve path placeholders for presets
              let resolvedArgs = config.args || [];

              // Check if any args contain placeholders that need resolving
              const hasPlaceholders = resolvedArgs.some((arg) =>
                arg.includes('{SOFTWARE_DEV_SERVER_PATH}') ||
                arg.includes('{GUI_OPERATE_SERVER_PATH}')
              );

              if (hasPlaceholders) {
                // Get the appropriate preset based on config name
                let presetKey: string | null = null;
                if (config.name === 'Software_Development' || config.name === 'Software Development') {
                  presetKey = 'software-development';
                } else if (config.name === 'GUI_Operate' || config.name === 'GUI Operate') {
                  presetKey = 'gui-operate';
                }

                if (presetKey) {
                  const preset = mcpConfigStore.createFromPreset(presetKey, true);
                  if (preset && preset.args) {
                    resolvedArgs = preset.args;
                  }
                }
              }

              mcpServers[serverKey] = {
                type: 'stdio',
                command,
                args: resolvedArgs,
                env: serverEnv,
              };
              log(`[ClaudeAgentRunner] Added STDIO MCP server: ${serverKey}`);
              log(`[ClaudeAgentRunner]   Command: ${command} ${resolvedArgs.join(' ')}`);
              log(`[ClaudeAgentRunner]   Tools will be named: mcp__${serverKey}__<toolName>`);
            } else if (config.type === 'sse') {
              mcpServers[serverKey] = {
                type: 'sse',
                url: config.url,
                headers: config.headers || {},
              };
              log(`[ClaudeAgentRunner] Added SSE MCP server: ${serverKey}`);
            }
          } catch (error) {
            logError('[ClaudeAgentRunner] Failed to prepare MCP server config, skipping server', {
              serverId: config.id,
              serverName: config.name,
              error: toErrorText(error),
            });
          }
        }

        const mcpServersSummary = Object.entries(mcpServers).map(([name, serverConfig]) => {
          const typedServerConfig = serverConfig as {
            type?: string;
            command?: string;
            args?: unknown[];
            env?: Record<string, unknown>;
          };
          return {
            name,
            type: typedServerConfig.type ?? 'unknown',
            command: typedServerConfig.command ?? '',
            argsCount: Array.isArray(typedServerConfig.args) ? typedServerConfig.args.length : 0,
            envKeys: typedServerConfig.env ? Object.keys(typedServerConfig.env).length : 0,
          };
        });
        log('[ClaudeAgentRunner] Final mcpServers summary:', safeStringify(mcpServersSummary, 2));
        if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
          log('[ClaudeAgentRunner] Final mcpServers config:', safeStringify(mcpServers, 2));
        }
      }
      logTiming('after building MCP servers config');
      
      // Get enableThinking from config
      const enableThinking = configStore.get('enableThinking') ?? false;
      log('[ClaudeAgentRunner] Enable thinking mode:', enableThinking);

      const runtimePlugins = this.pluginRuntimeService
        ? await this.pluginRuntimeService.getEnabledRuntimePlugins()
        : [];
      const sdkPlugins = runtimePlugins.map((plugin) => ({
        type: 'local' as const,
        path: plugin.runtimePath,
      }));
      if (sdkPlugins.length > 0) {
        log('[ClaudeAgentRunner] Runtime plugins enabled:', runtimePlugins.map((plugin) => ({
          pluginId: plugin.pluginId,
          name: plugin.name,
          runtimePath: plugin.runtimePath,
          enabledComponents: plugin.componentsEnabled,
        })));
      }

      const workspaceInfoPrompt = useSandboxIsolation && sandboxPath
        ? `<workspace_info>
Your current workspace is located at: ${VIRTUAL_WORKSPACE_PATH}
This is an isolated sandbox environment. Use ${VIRTUAL_WORKSPACE_PATH} as the root path for file operations.
</workspace_info>`
        : workingDir
          ? `<workspace_info>Your current workspace is: ${workingDir}</workspace_info>`
          : '';

      // 默认保留完整 MCP 工具说明，避免改变已稳定的提示词行为。
      // 仅在显式设置 COWORK_INCLUDE_MCP_TOOLS_PROMPT=0 时切换到精简版。
      const includeVerboseMcpPrompt = process.env.COWORK_INCLUDE_MCP_TOOLS_PROMPT !== '0';
      const includeCredentialsPrompt = /login|sign[\s-]?in|credential|password|gmail|邮箱|登录|账号|密码/i.test(prompt);
      const systemPromptSections = [
        'You are an Open Cowork coding assistant. Be concise, accurate, and tool-capable.',
        workspaceInfoPrompt,
        availableSkillsPrompt,
        includeVerboseMcpPrompt
          ? this.getMCPToolsPrompt()
          : `<mcp_tools>
MCP tools are available at runtime. Use tool names exactly as exposed by the init system message (mcp__<ServerName>__<toolName>).
</mcp_tools>`,
        `<citation_requirements>
If your answer uses linkable content from MCP tools, include a "Sources:" section and otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL).
</citation_requirements>`,
        includeCredentialsPrompt ? this.getCredentialsPrompt() : '',
        `<artifact_instructions>
When you produce a final deliverable file, declare it once using this exact block so the app can show it as the final artifact:
\`\`\`artifact
{"path":"/workspace/path/to/file.ext","name":"optional display name","type":"optional type"}
\`\`\`
</artifact_instructions>`,
      ].filter((section): section is string => Boolean(section && section.trim()));
      const systemPromptAppend = systemPromptSections.join('\n\n');
      
      // if (enableThinking) {
      //   envWithSkills.MAX_THINKING_TOKENS = '10000';
      // } else {
      //   envWithSkills.MAX_THINKING_TOKENS = '0';
      // }

      const maxTurnsFromEnv = Number.parseInt(process.env.COWORK_MAX_TURNS || '200', 10);
      const maxTurns = Number.isFinite(maxTurnsFromEnv) && maxTurnsFromEnv > 0
        ? maxTurnsFromEnv
        : 200;

      const queryOptions: any = {
        pathToClaudeCodeExecutable: claudeCodePath,
        cwd: workingDir,  // Windows path for claude-code process
        model: currentModel,
        maxTurns,
        abortController: controller,
        env: envWithSkills,
        thinking: buildThinkingOptions(enableThinking),
        plugins: sdkPlugins.length > 0 ? sdkPlugins : undefined,
        stderr: (data: string) => {
          const trimmed = data.trim();
          if (!trimmed) {
            return;
          }
          logError('[ClaudeAgentRunner][stderr]', trimmed);
          if (!lastAssistantApiErrorText) {
            lastAssistantApiErrorText = trimmed;
          }
        },
        
        // Pass MCP servers to SDK
        mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,

        // Custom spawn function to handle Node.js execution
        // Prefer system Node.js to avoid Electron's Dock icon appearing on macOS
        spawnClaudeCodeProcess: (spawnOptions: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => {
          const { command, args, cwd: spawnCwd, env: spawnEnv, signal } = spawnOptions;
          const hasIncomingEnv = Boolean(spawnEnv && Object.keys(spawnEnv).length > 0);
          if (!hasIncomingEnv) {
            logWarn('[ClaudeAgentRunner] SDK spawn env is empty; falling back to configured runtime env');
          }

          let actualCommand = command;
          let actualArgs = args;
          let actualEnv: NodeJS.ProcessEnv = { ...(hasIncomingEnv ? spawnEnv : envWithSkills) };
          const hasAuthInSpawnEnv = Boolean(
            actualEnv.ANTHROPIC_API_KEY
              || actualEnv.ANTHROPIC_AUTH_TOKEN
              || actualEnv.OPENAI_API_KEY
          );
          if (!hasAuthInSpawnEnv) {
            actualEnv = { ...envWithSkills, ...actualEnv };
            logWarn('[ClaudeAgentRunner] Spawn env missing auth vars, merged runtime auth env fallback');
          }
          actualEnv = withBunHashShimEnv(actualEnv);
          let spawnOptions2: any = {
            cwd: spawnCwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: actualEnv,
            signal,
          };
          
          // If the command is 'node', use bundled Node.js from resources
          if (command === 'node') {
            // Get bundled Node.js path (same logic as MCPManager)
            const platform = process.platform;
            const arch = process.arch;
            
            let resourcesPath: string;
            if (process.env.NODE_ENV === 'development') {
              // Development: use downloaded node in resources/node
              const projectRoot = path.join(__dirname, '..', '..');
              resourcesPath = path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`);
            } else {
              // Production: use bundled node in extraResources
              resourcesPath = path.join(process.resourcesPath, 'node');
            }
            
            const binDir = platform === 'win32' ? resourcesPath : path.join(resourcesPath, 'bin');
            const nodeExe = platform === 'win32' ? 'node.exe' : 'node';
            const bundledNodePath = path.join(binDir, nodeExe);
            
            if (fs.existsSync(bundledNodePath)) {
              actualCommand = bundledNodePath;
              log('[ClaudeAgentRunner] Using bundled Node.js:', bundledNodePath);
            } else {
              // Fallback to Electron as Node.js if bundled node not found
              log('[ClaudeAgentRunner] Bundled Node.js not found, using Electron as fallback');
              if (process.platform === 'darwin') {
                const electronPath = process.execPath.replace(/'/g, "'\''");
                const quotedArgs = args.map(a => `'${a.replace(/'/g, "'\''")}'`).join(' ');
                const shellCommand = `ELECTRON_RUN_AS_NODE=1 '${electronPath}' ${quotedArgs}`;
                actualCommand = '/bin/bash';
                actualArgs = ['-c', shellCommand];
              } else {
                actualCommand = process.execPath;
                actualEnv = { ...actualEnv, ELECTRON_RUN_AS_NODE: '1' };
              }
              spawnOptions2.env = actualEnv;
            }
          }

          if (isNodeExecutable(actualCommand)) {
            actualArgs = withBunHashShimNodeArgs(actualArgs);
          }
          
          log('[ClaudeAgentRunner] Custom spawn:', actualCommand, actualArgs.slice(0, 2).join(' ').substring(0, 100), '...');
          log('[ClaudeAgentRunner] Process cwd:', spawnCwd);

          const childProcess = spawn(actualCommand, actualArgs, spawnOptions2) as ChildProcess;
          childProcess.stderr?.on('data', (data) => {
            const stderrText = data.toString().trim();
            if (!stderrText) {
              return;
            }
            logError('[ClaudeAgentRunner][stderr]', stderrText);
            if (!lastAssistantApiErrorText) {
              lastAssistantApiErrorText = stderrText;
            }
          });

          return childProcess;
        },
        
        // System prompt: keep stable default prompt shape; MCP tools details are enabled unless explicitly disabled.
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: systemPromptAppend,
        },
        
        // Use 'default' mode so canUseTool will be called for permission checks
        // 'bypassPermissions' skips canUseTool entirely!
        permissionMode: 'default',
        
        // CRITICAL: canUseTool callback for HARD sandbox enforcement + AskUserQuestion handling
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          options: { signal: AbortSignal; toolUseID: string }
        ): Promise<PermissionResult> => {
          log(`[Sandbox] Checking tool: ${toolName}`, safeStringify(input));
          
          // Special handling for AskUserQuestion - need to wait for user response
          if (toolName === 'AskUserQuestion') {
            const questionId = uuidv4();
            const questions = sanitizeAskUserQuestions(input.questions);
            
            log(`[AskUserQuestion] Sending ${questions.length} questions to UI`);
            
            // Send questions to frontend
            this.sendToRenderer({
              type: 'question.request',
              payload: {
                questionId,
                sessionId: session.id,
                toolUseId: options.toolUseID,
                questions,
              },
            });
            
            // Wait for user's answers
            const answersJson = await new Promise<string>((resolve) => {
              this.pendingQuestions.set(questionId, { questionId, resolve });
              
              // Handle abort
              options.signal.addEventListener('abort', () => {
                this.pendingQuestions.delete(questionId);
                resolve('{}'); // Return empty object on abort
              });
            });
            
            log(`[AskUserQuestion] User answered:`, answersJson);
            
            const normalizedAnswers = normalizeAskUserAnswers(answersJson, questions);
            if (answersJson.trim() && Object.keys(normalizedAnswers).length === 0) {
              logWarn('[AskUserQuestion] No valid answers parsed from user response payload');
            }
            
            const updatedInput: Record<string, unknown> = { questions };
            if (Object.keys(normalizedAnswers).length > 0) {
              updatedInput.answers = normalizedAnswers;
            }

            return {
              behavior: 'allow',
              updatedInput,
            };
          }
          
          // Extract all paths from input for sandbox validation
          const paths = extractPathsFromInput(toolName, input);
          log(`[Sandbox] Extracted paths:`, paths);
          
          // Validate each path
          // for (const p of paths) {
          //   if (!isPathInsideWorkspace(p)) {
          //     logWarn(`[Sandbox] BLOCKED: Path "${p}" is outside workspace "${workingDir}"`);
          //     return {
          //       behavior: 'deny',
          //       message: `Access denied: Path "${p}" is outside the allowed workspace "${workingDir}". Only files within the workspace can be accessed.`
          //     };
          //   }
          // }
          
          // NOTE: Bash tool is intercepted by PreToolUse hook above for WSL wrapping
          // Glob/Grep/Read/Write/Edit use the shared filesystem (/mnt/)
          // They execute on Windows but access the same files as WSL
          // Path validation is done above
          
          log(`[Sandbox] ALLOWED: Tool ${toolName}`);
          return { behavior: 'allow', updatedInput: input };
        },
      };
      
      if (resumeId) {
        queryOptions.resume = resumeId;
        log('[ClaudeAgentRunner] Resuming SDK session:', resumeId);
      }
      log('[ClaudeAgentRunner] Sandbox via canUseTool, workspace:', workingDir);
      logTiming('before query() call - SDK initialization starts');

      let firstMessageReceived = false;
      let apiWaitStartedAt: number | null = null;

      // Create query input based on whether we have images
      const queryInput = hasImages
        ? {
            // For images: use AsyncIterable format with full message content
            prompt: (async function* () {
              // Convert last user message to SDK format with images
              if (lastUserMessage && lastUserMessage.role === 'user') {
                // Convert ContentBlock[] to Anthropic SDK's ContentBlockParam[]
                const sdkContent = lastUserMessage.content.map((block: any) => {
                  if (block.type === 'text') {
                    return { type: 'text' as const, text: block.text };
                  } else if (block.type === 'image') {
                    return {
                      type: 'image' as const,
                      source: {
                        type: 'base64' as const,
                        media_type: block.source.media_type,
                        data: block.source.data,
                      },
                    };
                  }
                  return block; // fallback for other types
                });

                yield {
                  type: 'user' as const,
                  message: {
                    role: 'user' as const,
                    content: sdkContent, // Include all content blocks (text + images)
                  },
                  parent_tool_use_id: null,
                  session_id: session.id,
                } as any; // Use 'as any' to bypass type checking since SDK types are complex
              }
            })(),
            options: queryOptions,
          }
        : {
            // For text-only: use simple string prompt
            prompt: contextualPrompt,
            options: queryOptions,
          };
      
      const queryInputSummary = summarizeQueryInputForLog(queryInput);
      log('[ClaudeAgentRunner] Query input summary:', safeStringify(queryInputSummary, 2));
      if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
        log('[ClaudeAgentRunner] Query input (full):', safeStringify(redactQueryInputForLog(queryInput), 2));
      }
      
      // Retry configuration
      const maxRetriesFromEnv = Number.parseInt(
        process.env.COWORK_MAX_API_RETRIES || process.env.COWORK_MAX_RETRIES || '2',
        10
      );
      const MAX_RETRIES = Number.isFinite(maxRetriesFromEnv) && maxRetriesFromEnv >= 0
        ? Math.min(maxRetriesFromEnv, 5)
        : 2;
      const retryBaseDelayFromEnv = Number.parseInt(process.env.COWORK_API_RETRY_BASE_DELAY_MS || '600', 10);
      const retryMaxDelayFromEnv = Number.parseInt(process.env.COWORK_API_RETRY_MAX_DELAY_MS || '4000', 10);
      const RETRY_BASE_DELAY_MS = Number.isFinite(retryBaseDelayFromEnv) && retryBaseDelayFromEnv > 0
        ? retryBaseDelayFromEnv
        : 600;
      const RETRY_MAX_DELAY_MS = Number.isFinite(retryMaxDelayFromEnv) && retryMaxDelayFromEnv > 0
        ? retryMaxDelayFromEnv
        : 4000;
      let retryCount = 0;
      let shouldContinue = true;
      let sdkApiKeySource: string | null = null;
      let lastAssistantApiErrorText = '';
      let emittedVisibleOutput = false;
      const firstResponseTimeoutFromEnv = Number.parseInt(process.env.COWORK_FIRST_RESPONSE_TIMEOUT_MS || '120000', 10);
      const firstResponseTimeoutMs = Number.isFinite(firstResponseTimeoutFromEnv) && firstResponseTimeoutFromEnv > 0
        ? firstResponseTimeoutFromEnv
        : 120000;
      let responseWatchdog: NodeJS.Timeout | null = null;
      let timeoutTriggered = false;
      const clearResponseWatchdog = () => {
        if (responseWatchdog) {
          clearTimeout(responseWatchdog);
          responseWatchdog = null;
        }
      };
      const resetResponseWatchdog = () => {
        if (controller.signal.aborted || firstResponseTimeoutMs <= 0) {
          return;
        }
        clearResponseWatchdog();
        responseWatchdog = setTimeout(() => {
          timeoutTriggered = true;
          logWarn('[ClaudeAgentRunner] First response watchdog timeout triggered', {
            sessionId: session.id,
            timeoutMs: firstResponseTimeoutMs,
          });
          controller.abort();
        }, firstResponseTimeoutMs);
      };
      
      while (shouldContinue) {
        try {
      lastAssistantApiErrorText = '';
      timeoutTriggered = false;
      resetResponseWatchdog();
      for await (const message of query(queryInput)) {
        resetResponseWatchdog();
        if (!firstMessageReceived) {
          logTiming('FIRST MESSAGE RECEIVED from SDK');
          firstMessageReceived = true;
        }
        
        if (controller.signal.aborted) break;

        log('[ClaudeAgentRunner] Message type:', message.type);
        log('[ClaudeAgentRunner] Message summary:', safeStringify(summarizeSdkMessageForLog(message), 2));
        if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
          log('[ClaudeAgentRunner] Full message:', safeStringify(message, 2));
        }

        if (message.type === 'system' && (message as any).subtype === 'init') {
          const source = (message as any).apiKeySource;
          if (typeof source === 'string' && source.trim()) {
            sdkApiKeySource = source.trim();
            log('[ClaudeAgentRunner] SDK apiKeySource:', sdkApiKeySource);
          }
          const sdkSessionId = (message as any).session_id;
          if (sdkSessionId) {
            this.sdkSessions.set(session.id, sdkSessionId);
            log('[ClaudeAgentRunner] SDK session initialized:', sdkSessionId);
            log('[ClaudeAgentRunner] Waiting for API response...');
            apiWaitStartedAt = Date.now();
          }
          const sdkPluginsInSession = ((message as any).plugins ?? []) as Array<{ name?: string; path?: string }>;
          this.sendToRenderer({
            type: 'plugins.runtimeApplied',
            payload: {
              sessionId: session.id,
              plugins: sdkPluginsInSession
                .filter((plugin) => typeof plugin.name === 'string' && typeof plugin.path === 'string')
                .map((plugin) => ({ name: plugin.name as string, path: plugin.path as string })),
            },
          });
        } else if (message.type === 'assistant') {
          log('[ClaudeAgentRunner] First assistant response received (API processing complete)');
          if (apiWaitStartedAt) {
            log('[ClaudeAgentRunner] API wait duration after SDK init:', Date.now() - apiWaitStartedAt, 'ms');
            apiWaitStartedAt = null;
          }
          logTiming('assistant response received');
          const assistantErrorText = typeof (message as any).error === 'string'
            ? (message as any).error.trim()
            : '';
          if (assistantErrorText) {
            lastAssistantApiErrorText = assistantErrorText;
          }
          // Assistant message - extract content from message.message.content
          const content = (message as any).message?.content || (message as any).content;
          log('[ClaudeAgentRunner] Assistant content:', safeStringify(content));
          
          if (content && Array.isArray(content) && content.length > 0) {
            // Handle content - could be string or array of blocks
            let textContent = '';
            const contentBlocks: ContentBlock[] = [];

              if (typeof content === 'string') {
                if (isSyntheticEmptyAssistantText(content)) {
                  log('[ClaudeAgentRunner] Suppressing synthetic empty assistant text block');
                } else {
                  textContent = content;
                  contentBlocks.push({ type: 'text', text: content });
                }
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text') {
                    const blockText = typeof block.text === 'string' ? block.text : '';
                    if (isSyntheticEmptyAssistantText(blockText)) {
                      log('[ClaudeAgentRunner] Suppressing synthetic empty assistant text block');
                      continue;
                    }
                    textContent += blockText;
                    contentBlocks.push({ type: 'text', text: blockText });
                  } else if (block.type === 'tool_use') {
                  const invalidAskUserQuestionKeys = block.name === 'AskUserQuestion'
                    ? getInvalidAskUserQuestionRootKeys(block.input)
                    : [];
                  if (block.name === 'AskUserQuestion' && invalidAskUserQuestionKeys.length > 0) {
                    logWarn(
                      '[ClaudeAgentRunner] Skipping invalid AskUserQuestion tool_use from chat message',
                      safeStringify({ toolUseId: block.id, invalidRootKeys: invalidAskUserQuestionKeys })
                    );
                    this.sendTraceStep(session.id, {
                      id: block.id || uuidv4(),
                      type: 'tool_call',
                      status: 'running',
                      title: `${block.name}`,
                      toolName: block.name,
                      toolInput: block.input,
                      timestamp: Date.now(),
                    });
                    continue;
                  }

                  // Tool call - track the tool name for completion message
                  lastExecutedToolName = block.name as string;
                  
                  contentBlocks.push({
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: block.input
                  });

                  this.sendTraceStep(session.id, {
                    id: block.id || uuidv4(),
                    type: 'tool_call',
                    status: 'running',
                    title: `${block.name}`,
                    toolName: block.name,
                    toolInput: block.input,
                    timestamp: Date.now(),
                  });
                }
              }
            }

            if (
              textContent
              && /invalid api key|run\s*\/login/i.test(textContent)
              && sdkApiKeySource === 'none'
            ) {
              const provider = configStore.get('provider');
              const customProtocol = configStore.get('customProtocol');
              const isOpenAIProfile = provider === 'openai' || (provider === 'custom' && customProtocol === 'openai');
              if (isOpenAIProfile && !unifiedSdkEnabled) {
                const runtimeBaseUrl = envWithSkills.OPENAI_BASE_URL || envWithSkills.ANTHROPIC_BASE_URL || '(default)';
                const hint = `\n\n[Config hint] Runtime profile is ${provider}/${customProtocol || 'anthropic'} with base URL ${runtimeBaseUrl}. Claude Code reports apiKeySource=none, which means OPENAI_* credentials were not accepted in this SDK path. Try switching to Custom + Anthropic protocol for the same gateway, then save and retry.`;
                textContent += hint;
                contentBlocks.push({ type: 'text', text: hint });
                logWarn('[ClaudeAgentRunner] Added OpenAI-profile auth hint for apiKeySource=none', {
                  provider,
                  customProtocol,
                  runtimeBaseUrl,
                });
              }
            }

            const { cleanText, artifacts } = extractArtifactsFromText(textContent);
            if (artifacts.length > 0) {
              textContent = cleanText;
              let replacedText = false;
              const cleanedBlocks: ContentBlock[] = [];
              for (const block of contentBlocks) {
                if (block.type === 'text') {
                  if (!replacedText) {
                    if (cleanText) {
                      cleanedBlocks.push({ type: 'text', text: cleanText });
                    }
                    replacedText = true;
                  }
                  continue;
                }
                cleanedBlocks.push(block);
              }
              if (!replacedText && cleanText) {
                cleanedBlocks.unshift({ type: 'text', text: cleanText });
              }
              contentBlocks.length = 0;
              contentBlocks.push(...cleanedBlocks);

              for (const step of buildArtifactTraceSteps(artifacts)) {
                this.sendTraceStep(session.id, step);
              }
            }

            // 记录上游 API 错误文本用于后续分类（例如进程退出 code=1 时判定是否重试）。
            if (textContent && textContent.toLowerCase().includes('api error')) {
              lastAssistantApiErrorText = textContent;
              logError('[ClaudeAgentRunner] Detected API error in assistant message:', textContent);
            }

            // Stream text to UI
            if (textContent) {
              const chunks = textContent.match(/.{1,30}/g) || [textContent];
              for (const chunk of chunks) {
                if (controller.signal.aborted) break;
                this.sendPartial(session.id, chunk);
                await this.delay(12, controller.signal);
              }

              // Clear partial
              this.sendToRenderer({
                type: 'stream.partial',
                payload: { sessionId: session.id, delta: '' },
              });
            }

            // Send message to UI
            if (contentBlocks.length > 0) {
              log('[ClaudeAgentRunner] Sending assistant message with', contentBlocks.length, 'blocks');
              emittedVisibleOutput = true;
              const assistantMsg: Message = {
                id: uuidv4(),
                sessionId: session.id,
                role: 'assistant',
                content: contentBlocks,
                timestamp: Date.now(),
              };
              this.sendMessage(session.id, assistantMsg);
            } else {
              log('[ClaudeAgentRunner] No content blocks to send!');
            }
          }
        } else if (message.type === 'user') {
          // Tool results from SDK
          const content = (message as any).message?.content;

          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const isError = block.is_error === true;

                // Debug: Log the raw block structure
                log(`[ClaudeAgentRunner] Raw tool_result block:`, safeStringify(block, 2).substring(0, 500));
                log(`[ClaudeAgentRunner] block.content type: ${Array.isArray(block.content) ? 'array' : typeof block.content}`);

                // Handle MCP tool results with content arrays (e.g., text + image)
                let textContent = '';
                const images: Array<{ data: string; mimeType: string }> = [];

                if (Array.isArray(block.content)) {
                  // MCP tool returned content array (e.g., screenshot_for_display)
                  log(`[ClaudeAgentRunner] Tool result content is array, length: ${block.content.length}`);
                  for (const contentItem of block.content) {
                    log(`[ClaudeAgentRunner] Content item type: ${contentItem.type}`);
                    if (contentItem.type === 'text') {
                      textContent += (contentItem.text || '');
                    } else if (contentItem.type === 'image') {
                      // Extract image data from MCP SDK format
                      // MCP SDK returns: { type: 'image', source: { data: '...', media_type: '...', type: 'base64' } }
                      const imageData = contentItem.source?.data || contentItem.data || '';
                      const mimeType = contentItem.source?.media_type || contentItem.mimeType || 'image/png';
                      const imageDataLength = imageData.length;
                      log(`[ClaudeAgentRunner] Extracting image data, length: ${imageDataLength}, mimeType: ${mimeType}`);
                      images.push({
                        data: imageData,
                        mimeType: mimeType
                      });
                    }
                  }
                  log(`[ClaudeAgentRunner] Extracted ${images.length} images`);
                } else {
                  // Standard string content
                  textContent = typeof block.content === 'string'
                    ? block.content
                    : safeStringify(block.content);
                }

                // Sanitize output to replace real sandbox paths with virtual workspace paths
                const sanitizedContent = sanitizeOutputPaths(textContent);

                if (isError && isAskUserQuestionSchemaError(sanitizedContent)) {
                  logWarn('[ClaudeAgentRunner] AskUserQuestion schema validation failed, waiting for model retry');
                  this.sendTraceUpdate(session.id, block.tool_use_id, {
                    status: 'error',
                    toolOutput: sanitizedContent.slice(0, 800),
                  });
                  continue;
                }

                // Update the existing tool_call trace step instead of creating a new one
                this.sendTraceUpdate(session.id, block.tool_use_id, {
                  status: isError ? 'error' : 'completed',
                  toolOutput: sanitizedContent.slice(0, 800),
                });

                // Send tool result message with optional images
                const toolResultMsg: Message = {
                  id: uuidv4(),
                  sessionId: session.id,
                  role: 'assistant',
                  content: [{
                    type: 'tool_result',
                    toolUseId: block.tool_use_id,
                    content: sanitizedContent,
                    isError,
                    ...(images.length > 0 && { images })
                  }],
                  timestamp: Date.now(),
                };
                emittedVisibleOutput = true;
                this.sendMessage(session.id, toolResultMsg);
              }
            }
          }
        } else if (message.type === 'result') {
          // Final result
          log('[ClaudeAgentRunner] Result received');
          const resultSubtype = typeof (message as any).subtype === 'string'
            ? (message as any).subtype
            : 'unknown';
          const resultIsError = Boolean((message as any).is_error);
          const resultParts: string[] = [];
          const resultText = typeof (message as any).result === 'string' ? (message as any).result.trim() : '';
          const resultError = typeof (message as any).error === 'string' ? (message as any).error.trim() : '';
          if (resultText) {
            resultParts.push(resultText);
          }
          if (resultError) {
            resultParts.push(resultError);
          }
          const resultErrors = Array.isArray((message as any).errors) ? (message as any).errors : [];
          appendDiagnosticParts(resultParts, resultErrors);
          const permissionDenials = Array.isArray((message as any).permission_denials)
            ? (message as any).permission_denials
            : [];
          if (permissionDenials.length > 0) {
            resultParts.push(`permission_denials=${safeStringify(permissionDenials)}`);
          }
          if (lastAssistantApiErrorText) {
            appendDiagnosticParts(resultParts, lastAssistantApiErrorText);
          }

          if (resultSubtype !== 'success' || resultIsError) {
            let diagnostic = resultParts.join(' | ');
            if (!diagnostic) {
              const rawResultMessage = safeStringify(message);
              diagnostic = rawResultMessage && rawResultMessage !== '{}'
                ? rawResultMessage
                : `result_subtype=${resultSubtype}`;
            }
            if (!lastAssistantApiErrorText && diagnostic) {
              lastAssistantApiErrorText = diagnostic;
            }
            logError('[ClaudeAgentRunner] SDK result indicates execution failure', {
              subtype: resultSubtype,
              isError: resultIsError,
              diagnostic: diagnostic.slice(0, 400),
            });
            throw new Error(`sdk_result_${resultSubtype}: ${diagnostic}`);
          }
          
          // If the result text is empty but tools were executed, add a completion message
          // This happens when Claude calls tools but doesn't generate follow-up text
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const finalResultText = (message as any).result as string || '';
          if (!finalResultText.trim() && !emittedVisibleOutput) {
            throw new Error('empty_success_result: upstream returned success with no visible assistant content');
          }
          if (!finalResultText.trim() && lastExecutedToolName) {
            log(`[ClaudeAgentRunner] Empty result after tool execution (${lastExecutedToolName}), adding completion message`);
            
            // Generate appropriate completion message based on the tool
            let completionText = '';
            if (lastExecutedToolName === 'Write') {
              completionText = `✓ File has been created successfully.`;
            } else if (lastExecutedToolName === 'Edit') {
              completionText = `✓ File has been edited successfully.`;
            } else if (lastExecutedToolName === 'Read') {
              // Read tool typically shows content, no need for extra message
            } else if (['Bash', 'Glob', 'Grep', 'LS'].includes(lastExecutedToolName)) {
              // These tools show their output directly, no need for extra message
            } else {
              // completionText = `✓ Task completed.`;
              // completionText = `Tool executed.`;
            }
            
            if (completionText) {
              emittedVisibleOutput = true;
              const completionMsg: Message = {
                id: uuidv4(),
                sessionId: session.id,
                role: 'assistant',
                content: [{ type: 'text', text: completionText }],
                timestamp: Date.now(),
              };
              this.sendMessage(session.id, completionMsg);
            }
          }
        }
      }
      
      // Successfully completed the query loop
      log('[ClaudeAgentRunner] Query completed successfully');
      clearResponseWatchdog();
      shouldContinue = false;
      
    } catch (error) {
      clearResponseWatchdog();
      // Handle errors with retry logic
      const err = error as Error;
      
      // Log the full error for debugging
      logError(`[ClaudeAgentRunner] Caught error:`, err);
      logError(`[ClaudeAgentRunner] Error name: ${err.name}`);
      logError(`[ClaudeAgentRunner] Error message: ${err.message}`);
      logError(`[ClaudeAgentRunner] Error stack: ${err.stack}`);
      
      // Check if this is an abort error - don't retry
      if (err.name === 'AbortError') {
        if (timeoutTriggered) {
          throw new Error(`first_response_timeout: no SDK activity for ${firstResponseTimeoutMs}ms`);
        }
        log('[ClaudeAgentRunner] Query aborted by user');
        throw err;
      }
      
      // Check if this is a retryable error
      const errorMessage = err.message || String(error);
      const errorString = String(error);
      const fullErrorText = `${errorMessage} ${errorString} ${lastAssistantApiErrorText}`;
      const isRetryable = isRetryableApiErrorText(fullErrorText);
      
      logError(`[ClaudeAgentRunner] Is retryable: ${isRetryable}, retryCount: ${retryCount}/${MAX_RETRIES}`);
      
      if (isRetryable && retryCount < MAX_RETRIES) {
        retryCount++;
        const waitTime = Math.min(
          RETRY_BASE_DELAY_MS * Math.pow(2, retryCount - 1),
          RETRY_MAX_DELAY_MS
        );
        
        logError(`[ClaudeAgentRunner] Retryable error (attempt ${retryCount}/${MAX_RETRIES}): ${errorMessage}`);
        log(`[ClaudeAgentRunner] Waiting ${waitTime}ms before retry...`);
        
        // Show retry message to user
        this.sendToRenderer({
          type: 'stream.partial',
          payload: { 
            sessionId: session.id, 
            delta: `\n\n⚠️ API调用出错，正在重试 (${retryCount}/${MAX_RETRIES})...\n\n` 
          },
        });
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Clear the retry message
        this.sendToRenderer({
          type: 'stream.partial',
          payload: { sessionId: session.id, delta: '' },
        });
        
        // Get the current SDK session ID for resume
        const currentSdkSessionId = this.sdkSessions.get(session.id);
        if (currentSdkSessionId) {
          log(`[ClaudeAgentRunner] Resuming from SDK session: ${currentSdkSessionId}`);
          
          // Update queryInput to use resume
          if (hasImages) {
            (queryInput as any).options.resume = currentSdkSessionId;
          } else {
            (queryInput as any).options.resume = currentSdkSessionId;
          }
          
          // Continue the while loop to retry
          shouldContinue = true;
        } else {
          logError(`[ClaudeAgentRunner] No SDK session ID found for resume, cannot retry`);
          throw err;
        }
      } else {
        // Not retryable or max retries exceeded
        if (retryCount >= MAX_RETRIES) {
          logError(`[ClaudeAgentRunner] Max retries (${MAX_RETRIES}) exceeded`);
        } else {
          logError(`[ClaudeAgentRunner] Non-retryable error: ${errorMessage}`);
        }
        throw err;
      }
    }
  }
  
  // If we exit the retry loop, check if there was an error
  if (shouldContinue) {
    throw new Error('Retry loop exited unexpectedly');
      }

      // Complete - update the initial thinking step
      this.sendTraceUpdate(session.id, thinkingStepId, {
        status: 'completed',
        title: 'Task completed',
      });

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        log('[ClaudeAgentRunner] Aborted');
      } else {
        logError('[ClaudeAgentRunner] Error:', error);
        
        const errorText = toUserFacingErrorText(toErrorText(error));
        const errorMsg: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [{ type: 'text', text: `**Error**: ${errorText}` }],
          timestamp: Date.now(),
        };
        this.sendMessage(session.id, errorMsg);

        this.sendTraceStep(session.id, {
          id: uuidv4(),
          type: 'thinking',
          status: 'error',
          title: 'Error occurred',
          timestamp: Date.now(),
        });
      }
    } finally {
      if (proxyLeaseSignature) {
        await claudeProxyManager.release(proxyLeaseSignature);
      }
      this.activeControllers.delete(session.id);
      this.pathResolver.unregisterSession(session.id);

      // Sync changes from sandbox back to host OS (but don't cleanup - sandbox persists)
      // Cleanup happens on session delete or app shutdown
      if (useSandboxIsolation && sandboxPath) {
        const sandbox = getSandboxAdapter();

        if (sandbox.isWSL) {
          log('[ClaudeAgentRunner] Syncing sandbox changes to Windows (sandbox persists for this conversation)...');
          const syncResult = await SandboxSync.syncToWindows(session.id);
          if (syncResult.success) {
            log('[ClaudeAgentRunner] Sync completed successfully');
          } else {
            logError('[ClaudeAgentRunner] Sync failed:', syncResult.error);
          }
        } else if (sandbox.isLima) {
          log('[ClaudeAgentRunner] Syncing sandbox changes to macOS (sandbox persists for this conversation)...');
          const { LimaSync } = await import('../sandbox/lima-sync');
          const syncResult = await LimaSync.syncToMac(session.id);
          if (syncResult.success) {
            log('[ClaudeAgentRunner] Sync completed successfully');
          } else {
            logError('[ClaudeAgentRunner] Sync failed:', syncResult.error);
          }
        }

        // Note: Sandbox is NOT cleaned up here - it persists across messages in the same conversation
        // Cleanup occurs when:
        // 1. User deletes the conversation (SessionManager.deleteSession)
        // 2. App is closed (SandboxSync/LimaSync.cleanupAllSessions)
      }
    }
  }

  cancel(sessionId: string): void {
    const controller = this.activeControllers.get(sessionId);
    if (controller) controller.abort();
  }

  private sendTraceStep(sessionId: string, step: TraceStep): void {
    log(`[Trace] ${step.type}: ${step.title}`);
    this.sendToRenderer({ type: 'trace.step', payload: { sessionId, step } });
  }

  private sendTraceUpdate(sessionId: string, stepId: string, updates: Partial<TraceStep>): void {
    log(`[Trace] Update step ${stepId}:`, updates);
    this.sendToRenderer({ type: 'trace.update', payload: { sessionId, stepId, updates } });
  }

  private sendMessage(sessionId: string, message: Message): void {
    // Save message to database for persistence
    if (this.saveMessage) {
      this.saveMessage(message);
    }
    // Send to renderer for UI update
    this.sendToRenderer({ type: 'stream.message', payload: { sessionId, message } });
  }

  private sendPartial(sessionId: string, delta: string): void {
    this.sendToRenderer({ type: 'stream.partial', payload: { sessionId, delta } });
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeout);
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
