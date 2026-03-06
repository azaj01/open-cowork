import { describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesRunner } from '../src/main/openai/responses-runner';

describe('OpenAIResponsesRunner AskUserQuestion lifecycle', () => {
  it('rejects pending AskUserQuestion when session is cancelled', async () => {
    const runner = new OpenAIResponsesRunner({
      sendToRenderer: vi.fn(),
    });

    const pending = (runner as any).requestUserQuestion('session-1', 'tool-1', [
      { question: 'Choose one', header: 'Scope' },
    ]);

    runner.cancel('session-1');

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Question request cancelled',
    });
    expect((runner as any).pendingQuestions.size).toBe(0);
  });

  it('resolves pending AskUserQuestion when response arrives', async () => {
    const runner = new OpenAIResponsesRunner({
      sendToRenderer: vi.fn(),
    });

    const pending = (runner as any).requestUserQuestion('session-2', 'tool-2', [
      { question: 'Choose one', header: 'Scope' },
    ]);
    const questionId = Array.from((runner as any).pendingQuestions.keys())[0] as string;

    runner.handleQuestionResponse(questionId, '{"0":["A"]}');

    await expect(pending).resolves.toBe('{"0":["A"]}');
    expect((runner as any).pendingQuestions.size).toBe(0);
  });
});
