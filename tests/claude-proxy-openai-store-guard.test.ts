import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('claude-code-proxy OpenAI store guard', () => {
  it('forces store=false for openai upstream requests', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(testDir, '../vendor/claude-code-proxy/server.py'),
      'utf-8'
    );

    const openaiBranchIndex = source.indexOf('if should_use_openai_provider:');
    expect(openaiBranchIndex).toBeGreaterThanOrEqual(0);
    expect(source).toContain('PREFERRED_PROVIDER == "openai"');

    const storeFalseIndex = source.indexOf('litellm_request["store"] = False');
    expect(storeFalseIndex).toBeGreaterThan(openaiBranchIndex);
  });

  it('does not exclude gemini-prefixed models from openai-compatible upstream routing', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(testDir, '../vendor/claude-code-proxy/server.py'),
      'utf-8'
    );

    expect(source).toContain('PREFERRED_PROVIDER == "openai" and bool(OPENAI_API_KEY)');
    expect(source).not.toContain('not is_gemini_model and not is_anthropic_model');
  });

  it('forwards configured openai default headers to litellm requests', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(testDir, '../vendor/claude-code-proxy/server.py'),
      'utf-8'
    );

    const openaiBranchIndex = source.indexOf('if should_use_openai_provider:');
    expect(openaiBranchIndex).toBeGreaterThanOrEqual(0);
    expect(source).toContain('OPENAI_DEFAULT_HEADERS_JSON = os.environ.get("OPENAI_DEFAULT_HEADERS_JSON", "").strip()');

    const headersIndex = source.indexOf('litellm_request["extra_headers"] = {');
    expect(headersIndex).toBeGreaterThan(openaiBranchIndex);
  });

  it('forwards configured gemini base url to litellm request and token counter', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(testDir, '../vendor/claude-code-proxy/server.py'),
      'utf-8'
    );

    expect(source).toContain('GEMINI_BASE_URL = os.environ.get("GEMINI_BASE_URL", "").strip()');
    expect(source).toContain('litellm_request["api_base"] = GEMINI_BASE_URL');
    expect(source).toContain('elif request.model.startswith("gemini/") and GEMINI_BASE_URL:');
  });
});
