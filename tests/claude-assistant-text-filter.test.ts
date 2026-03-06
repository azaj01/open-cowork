import { describe, expect, it } from 'vitest';
import { isSyntheticAssistantTextBlock } from '../src/main/claude/assistant-text-filter';

describe('Claude assistant synthetic text filter', () => {
  it('treats empty placeholders as synthetic assistant text', () => {
    expect(isSyntheticAssistantTextBlock('(no content)')).toBe(true);
    expect(isSyntheticAssistantTextBlock('(empty content)')).toBe(true);
  });

  it('treats tool transcript placeholders as synthetic assistant text', () => {
    const raw = `(no content) [Tool: mcp__Chrome__navigate_page (ID: tool_mcp__Chrome__navigate_page_abc)] Input: {"url":"https://huggingface.co/papers/date/2026-03-06"}`;
    expect(isSyntheticAssistantTextBlock(raw)).toBe(true);
  });

  it('treats multiline tool transcript blocks as synthetic assistant text', () => {
    const raw = `(no content) [Tool: mcp__Chrome__navigate_page (ID: tool_mcp__Chrome__navigate_page_abc)] Input: {"url":"https://huggingface.co/papers/date/2026-03-06"}\n\n[Tool: mcp__Chrome__navigate_page (ID: tool_mcp__Chrome__navigate_page_def)] Input: {"url":"https://huggingface.co/papers/date/2026-03-05"}`;
    expect(isSyntheticAssistantTextBlock(raw)).toBe(true);
  });

  it('keeps normal assistant prose visible', () => {
    expect(isSyntheticAssistantTextBlock('我已经找到了两篇相关论文，并整理了它们的摘要。')).toBe(false);
  });
});
