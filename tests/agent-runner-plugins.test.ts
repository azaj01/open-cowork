import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const agentRunnerPath = path.resolve(process.cwd(), 'src/main/claude/agent-runner.ts');
const agentRunnerContent = readFileSync(agentRunnerPath, 'utf8');

describe('ClaudeAgentRunner plugin runtime integration', () => {
  it('injects SDK local plugins into query options', () => {
    expect(agentRunnerContent).toContain('await this.pluginRuntimeService.getEnabledRuntimePlugins()');
    expect(agentRunnerContent).toContain("plugins: sdkPlugins.length > 0 ? sdkPlugins : undefined");
  });

  it('emits runtime applied plugin event after SDK init', () => {
    expect(agentRunnerContent).toContain("type: 'plugins.runtimeApplied'");
    expect(agentRunnerContent).toContain('sdkPluginsInSession');
  });

  it('avoids dynamic re-import shadowing for config store singletons', () => {
    expect(agentRunnerContent).toContain("import { mcpConfigStore } from '../mcp/mcp-config-store'");
    expect(agentRunnerContent).not.toContain("const { configStore } = await import('../config/config-store')");
    expect(agentRunnerContent).not.toContain("const { mcpConfigStore } = await import('../mcp/mcp-config-store')");
  });

  it('keeps MCP config build resilient and does not crash on log serialization', () => {
    expect(agentRunnerContent).toContain('function safeStringify');
    expect(agentRunnerContent).toContain('Failed to read enabled MCP configs; continuing without MCP overrides');
    expect(agentRunnerContent).toContain('Failed to prepare MCP server config, skipping server');
    expect(agentRunnerContent).not.toContain("JSON.stringify(message, null, 2)");
    expect(agentRunnerContent).not.toContain("JSON.stringify(queryInput, null, 2)");
  });

  it('normalizes AskUserQuestion answers to SDK-compatible shape', () => {
    expect(agentRunnerContent).toContain('function normalizeAskUserAnswers');
    expect(agentRunnerContent).toContain('const normalizedAnswers = normalizeAskUserAnswers(answersJson, questions)');
    expect(agentRunnerContent).toContain('updatedInput.answers = normalizedAnswers');
    expect(agentRunnerContent).not.toContain('let answers: Record<number, string[]> = {}');
    expect(agentRunnerContent).not.toContain('answer: answers[idx] || []');
  });

  it('skips rendering transient AskUserQuestion schema errors as chat tool results', () => {
    expect(agentRunnerContent).toContain('function isAskUserQuestionSchemaError');
    expect(agentRunnerContent).toContain('AskUserQuestion schema validation failed, waiting for model retry');
    expect(agentRunnerContent).toContain('if (isError && isAskUserQuestionSchemaError(sanitizedContent))');
  });

  it('suppresses invalid AskUserQuestion tool_use cards that contain known bad root keys', () => {
    expect(agentRunnerContent).toContain("const ASK_USER_QUESTION_INVALID_ROOT_KEYS = new Set(['type', 'header', 'multiSelect'])");
    expect(agentRunnerContent).toContain('getInvalidAskUserQuestionRootKeys(block.input)');
    expect(agentRunnerContent).toContain('Skipping invalid AskUserQuestion tool_use from chat message');
  });

  it('uses standard markdown link guidance for sources citations', () => {
    expect(agentRunnerContent).toContain('otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL)');
    expect(agentRunnerContent).not.toContain('otherwise use: ~[Title](https://claude.ai/chat/URL)~');
  });

  it('avoids duplicating the current user prompt in contextual history assembly', () => {
    expect(agentRunnerContent).toContain('const conversationMessages = existingMessages');
    expect(agentRunnerContent).toContain('conversationMessages.slice(0, -1)');
    expect(agentRunnerContent).toContain("conversationMessages[conversationMessages.length - 1]?.role === 'user'");
  });

  it('logs compact SDK diagnostics by default and keeps full payload logs behind an opt-in flag', () => {
    expect(agentRunnerContent).toContain('function summarizeQueryInputForLog');
    expect(agentRunnerContent).toContain('function summarizeSdkMessageForLog');
    expect(agentRunnerContent).toContain("log('[ClaudeAgentRunner] Query input summary:'");
    expect(agentRunnerContent).toContain("log('[ClaudeAgentRunner] Message summary:'");
    expect(agentRunnerContent).toContain("process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1'");
  });

  it('keeps MCP server logging compact unless full debug logging is enabled', () => {
    expect(agentRunnerContent).toContain("log('[ClaudeAgentRunner] Final mcpServers summary:'");
    expect(agentRunnerContent).toContain("if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {");
    expect(agentRunnerContent).toContain("log('[ClaudeAgentRunner] Final mcpServers config:'");
  });

  it('uses bounded max turns with env override instead of unbounded large defaults', () => {
    expect(agentRunnerContent).toContain("const maxTurnsFromEnv = Number.parseInt(process.env.COWORK_MAX_TURNS || '200', 10)");
    expect(agentRunnerContent).toContain('maxTurns,');
    expect(agentRunnerContent).not.toContain('maxTurns: 1000');
  });

  it('marks first response watchdog timeout as non-retryable', () => {
    expect(agentRunnerContent).toContain("first_response_timeout: no SDK activity for ${firstResponseTimeoutMs}ms");
    expect(agentRunnerContent).toContain("if (text.includes('first_response_timeout')) {");
    expect(agentRunnerContent).toContain('return false;');
  });

  it('uses bounded api retry policy and avoids long retry backoff tails', () => {
    expect(agentRunnerContent).toContain("process.env.COWORK_MAX_API_RETRIES || process.env.COWORK_MAX_RETRIES || '2'");
    expect(agentRunnerContent).toContain('Math.min(maxRetriesFromEnv, 5)');
    expect(agentRunnerContent).toContain('COWORK_API_RETRY_MAX_DELAY_MS');
  });

  it('extracts HTTP status and treats 4xx as non-retryable by default', () => {
    expect(agentRunnerContent).toContain('function extractStatusCodeFromErrorText');
    expect(agentRunnerContent).toContain('if (statusCode >= 400 && statusCode < 500)');
    expect(agentRunnerContent).toContain('return false;');
  });

  it('treats non-success SDK result subtype as execution failure instead of silent success', () => {
    expect(agentRunnerContent).toContain("if (resultSubtype !== 'success' || resultIsError)");
    expect(agentRunnerContent).toContain('SDK result indicates execution failure');
    expect(agentRunnerContent).toContain('throw new Error(`sdk_result_${resultSubtype}: ${diagnostic}`)');
  });

  it('captures claude-code stderr and enriches empty SDK result diagnostics', () => {
    expect(agentRunnerContent).toContain('childProcess.stderr?.on');
    expect(agentRunnerContent).toContain('[ClaudeAgentRunner][stderr]');
    expect(agentRunnerContent).toContain('safeStringify(message)');
  });

  it('records assistant error hints even when assistant content blocks are empty', () => {
    expect(agentRunnerContent).toContain('const assistantErrorText = typeof (message as any).error === \'string\'');
    expect(agentRunnerContent).toContain('lastAssistantApiErrorText = assistantErrorText');
  });

  it('maps watchdog timeout to a user-friendly message', () => {
    expect(agentRunnerContent).toContain('function toUserFacingErrorText');
    expect(agentRunnerContent).toContain('模型响应超时：长时间未收到上游返回');
    expect(agentRunnerContent).toContain('const errorText = toUserFacingErrorText(toErrorText(error));');
  });

  it('suppresses synthetic empty assistant text placeholders from SDK', () => {
    expect(agentRunnerContent).toContain("import { isSyntheticAssistantTextBlock } from './assistant-text-filter'");
    expect(agentRunnerContent).toContain('function isSyntheticEmptyAssistantText');
    expect(agentRunnerContent).toContain('return isSyntheticAssistantTextBlock(text);');
    expect(agentRunnerContent).toContain('Suppressing synthetic empty assistant text block');
  });

  it('treats empty success results without visible output as failures', () => {
    expect(agentRunnerContent).toContain('empty_success_result: upstream returned success with no visible assistant content');
    expect(agentRunnerContent).toContain("if (!finalResultText.trim() && !emittedVisibleOutput)");
    expect(agentRunnerContent).toContain('模型返回了一个空的成功结果');
  });
});
