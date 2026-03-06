import { existsSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface ResolvedClaudeCodePath {
  executablePath: string;
  source: string;
}

interface ResolveClaudeCodePathOptions {
  preferredPath?: string;
  env?: NodeJS.ProcessEnv;
}

const KNOWN_INVALID_MAIN_CLI_RE = /(?:^|[\\/])(dist-electron|dist|build)[\\/]+main[\\/]+cli\.js$/i;

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, '/');
}

export function isKnownInvalidClaudeCodePath(candidatePath?: string): boolean {
  const trimmed = candidatePath?.trim();
  if (!trimmed) {
    return false;
  }
  return KNOWN_INVALID_MAIN_CLI_RE.test(normalizePathForMatch(trimmed));
}

function firstExistingPath(
  candidates: Array<{ executablePath: string; source: string }>
): ResolvedClaudeCodePath | null {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const executablePath = candidate.executablePath?.trim();
    if (!executablePath || seen.has(executablePath)) {
      continue;
    }
    seen.add(executablePath);
    if (isUsableExecutablePath(executablePath)) {
      return { executablePath, source: candidate.source };
    }
  }
  return null;
}

function isUsableExecutablePath(executablePath: string): boolean {
  if (!existsSync(executablePath)) {
    return false;
  }
  try {
    return statSync(executablePath).isFile();
  } catch {
    return false;
  }
}

function collectPlatformCandidates(home: string, env: NodeJS.ProcessEnv): string[] {
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === 'win32') {
    const appData = env.APPDATA || '';
    candidates.push(
      path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    );
    return candidates;
  }

  if (platform === 'darwin') {
    candidates.push(
      '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      path.join(home, 'Library/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js'),
      path.join(home, '.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js')
    );

    const nvmDir = path.join(home, '.nvm/versions/node');
    if (existsSync(nvmDir)) {
      try {
        for (const version of readdirSync(nvmDir)) {
          candidates.push(path.join(nvmDir, version, 'lib/node_modules/@anthropic-ai/claude-code/cli.js'));
        }
      } catch {
        // ignore and continue with other candidates
      }
    }

    const fnmDir = path.join(home, 'Library/Application Support/fnm/node-versions');
    if (existsSync(fnmDir)) {
      try {
        for (const version of readdirSync(fnmDir)) {
          candidates.push(
            path.join(fnmDir, version, 'installation/lib/node_modules/@anthropic-ai/claude-code/cli.js')
          );
        }
      } catch {
        // ignore and continue with other candidates
      }
    }

    return candidates;
  }

  candidates.push(
    '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    path.join(home, '.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js')
  );

  const nvmDir = path.join(home, '.nvm/versions/node');
  if (existsSync(nvmDir)) {
    try {
      for (const version of readdirSync(nvmDir)) {
        candidates.push(path.join(nvmDir, version, 'lib/node_modules/@anthropic-ai/claude-code/cli.js'));
      }
    } catch {
      // ignore and continue with other candidates
    }
  }

  return candidates;
}

export function resolveClaudeCodeExecutablePath(
  options: ResolveClaudeCodePathOptions = {}
): ResolvedClaudeCodePath | null {
  const env = options.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || '';
  const candidates: Array<{ executablePath: string; source: string }> = [];

  if (options.preferredPath?.trim() && !isKnownInvalidClaudeCodePath(options.preferredPath)) {
    candidates.push({ executablePath: options.preferredPath.trim(), source: 'config.claudeCodePath' });
  }

  if (env.CLAUDE_CODE_PATH?.trim() && !isKnownInvalidClaudeCodePath(env.CLAUDE_CODE_PATH)) {
    candidates.push({ executablePath: env.CLAUDE_CODE_PATH.trim(), source: 'env.CLAUDE_CODE_PATH' });
  }

  if (process.resourcesPath) {
    candidates.push(
      {
        executablePath: path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'cli.js'
        ),
        source: 'resources.app.asar.unpacked',
      },
      {
        executablePath: path.join(process.resourcesPath, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        source: 'resources.node_modules',
      },
      {
        executablePath: path.join(
          process.resourcesPath,
          'app.asar',
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'cli.js'
        ),
        source: 'resources.app.asar',
      },
      {
        executablePath: path.join(
          process.resourcesPath,
          'app',
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'cli.js'
        ),
        source: 'resources.app.node_modules',
      }
    );
  }

  candidates.push(
    {
      executablePath: path.join(__dirname, '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      source: 'module.__dirname_up3',
    },
    {
      executablePath: path.join(__dirname, '..', '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      source: 'module.__dirname_up2',
    },
    {
      executablePath: path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      source: 'cwd.node_modules',
    }
  );

  const directMatch = firstExistingPath(candidates);
  if (directMatch) {
    return directMatch;
  }

  if (process.platform !== 'win32') {
    try {
      const whichPath = execSync('/bin/bash -l -c "which claude"', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (whichPath && isUsableExecutablePath(whichPath)) {
        return { executablePath: whichPath, source: 'shell.which_claude' };
      }
    } catch {
      // ignore and continue
    }

    try {
      const npmRoot = execSync('/bin/bash -l -c "npm root -g"', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      const globalCli = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');
      if (isUsableExecutablePath(globalCli)) {
        return { executablePath: globalCli, source: 'shell.npm_root_global' };
      }
    } catch {
      // ignore and continue
    }
  }

  const platformCandidates = collectPlatformCandidates(home, env).map((executablePath) => ({
    executablePath,
    source: 'platform.fallback',
  }));
  return firstExistingPath(platformCandidates);
}
