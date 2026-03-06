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
});
