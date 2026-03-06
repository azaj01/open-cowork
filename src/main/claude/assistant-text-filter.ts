const SYNTHETIC_EMPTY_TEXTS = new Set(['(no content)', '(empty content)']);

/**
 * 过滤 SDK 偶发注入的“伪正文”文本，避免工具调用转录混入聊天正文。
 */
export function isSyntheticAssistantTextBlock(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const lowered = normalized.toLowerCase();
  if (SYNTHETIC_EMPTY_TEXTS.has(lowered)) {
    return true;
  }

  const looksLikeToolTranscript =
    lowered.includes('[tool:') &&
    lowered.includes('input:') &&
    (lowered.includes('(id:') || lowered.includes('tool_') || lowered.includes('mcp__'));

  if (!looksLikeToolTranscript) {
    return false;
  }

  return lowered.startsWith('(no content)')
    || lowered.startsWith('(empty content)')
    || lowered.startsWith('[tool:');
}
