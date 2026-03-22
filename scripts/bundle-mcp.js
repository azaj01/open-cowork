/**
 * Build MCP server TypeScript files into self-contained CommonJS bundles.
 *
 * Uses esbuild to bundle all dependencies (e.g. @modelcontextprotocol/sdk)
 * into a single file per server, so the output can run standalone from
 * Resources/mcp/ without needing a node_modules directory.
 *
 * Falls back to TypeScript transpile-only if esbuild is not available
 * (e.g. locked-down Windows environments).
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const SRC_MCP_DIR = path.join(PROJECT_ROOT, 'src', 'main', 'mcp');
const DIST_MCP_DIR = path.join(PROJECT_ROOT, 'dist-mcp');

const servers = [
  {
    name: 'gui-operate-server',
    entry: 'gui-operate-server.ts',
    description: 'GUI Automation MCP Server',
  },
  {
    name: 'software-dev-server-example',
    entry: 'software-dev-server-example.ts',
    description: 'Software Development MCP Server',
  },
];

// Node built-ins that should NOT be bundled
const NODE_EXTERNALS = [
  'child_process',
  'crypto',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'stream',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib',
  'node:child_process',
  'node:crypto',
  'node:dns',
  'node:events',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:https',
  'node:net',
  'node:os',
  'node:path',
  'node:stream',
  'node:tls',
  'node:url',
  'node:util',
  'node:worker_threads',
  'node:zlib',
  'node:diagnostics_channel',
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function bundleWithEsbuild() {
  const esbuild = require('esbuild');

  for (const server of servers) {
    const entryPoint = path.join(SRC_MCP_DIR, server.entry);
    const outfile = path.join(DIST_MCP_DIR, `${server.name}.js`);

    await esbuild.build({
      entryPoints: [entryPoint],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: NODE_EXTERNALS,
      sourcemap: false,
      minify: false,
      logLevel: 'warning',
    });

    const stats = fs.statSync(outfile);
    const sizeKB = (stats.size / 1024).toFixed(2);
    console.log(`📦 ${server.description}`);
    console.log(`   Entry: ${server.entry}`);
    console.log(`   Output: dist-mcp/${server.name}.js (${sizeKB} KB, bundled)`);
  }
}

function transpileFallback() {
  const ts = require('typescript');

  console.log('⚠️  esbuild unavailable, falling back to TypeScript transpile-only');
  console.log('   Dependencies will NOT be bundled — MCP servers may fail in packaged builds.\n');

  const sourceFiles = fs.readdirSync(SRC_MCP_DIR).filter((file) => file.endsWith('.ts'));

  for (const file of sourceFiles) {
    const inputPath = path.join(SRC_MCP_DIR, file);
    const outputPath = path.join(DIST_MCP_DIR, file.replace(/\.ts$/, '.js'));
    const sourceText = fs.readFileSync(inputPath, 'utf8');
    const result = ts.transpileModule(sourceText, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        resolveJsonModule: true,
        allowSyntheticDefaultImports: true,
      },
      fileName: inputPath,
      reportDiagnostics: true,
    });

    if (result.diagnostics?.length) {
      const errors = result.diagnostics.filter(
        (d) => d.category === ts.DiagnosticCategory.Error
      );
      if (errors.length > 0) {
        throw new Error(
          `${file}\n${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`
        );
      }
    }

    fs.writeFileSync(outputPath, result.outputText);
  }

  for (const server of servers) {
    const outfile = path.join(DIST_MCP_DIR, `${server.name}.js`);
    const stats = fs.statSync(outfile);
    const sizeKB = (stats.size / 1024).toFixed(2);
    console.log(`📦 ${server.description}`);
    console.log(`   Entry: ${server.entry}`);
    console.log(`   Output: dist-mcp/${server.name}.js (${sizeKB} KB, transpile-only)`);
  }
}

async function bundleMCPServers() {
  console.log('🔨 Building MCP Servers...\n');
  ensureDir(DIST_MCP_DIR);

  try {
    require.resolve('esbuild');
    await bundleWithEsbuild();
  } catch {
    transpileFallback();
  }

  console.log('\n✅ All MCP servers built successfully!\n');
}

bundleMCPServers().catch((error) => {
  console.error('❌ Bundle failed:', error?.stack || error);
  process.exit(1);
});
