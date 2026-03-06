import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const messageCardPath = path.resolve(process.cwd(), 'src/renderer/components/MessageCard.tsx');
const messageCardContent = fs.readFileSync(messageCardPath, 'utf8');

describe('AskUserQuestion UI state rendering', () => {
  it('does not mark non-pending questions as answered by default', () => {
    expect(messageCardContent).toContain("const isAnswered = submitted;");
    expect(messageCardContent).toContain("const isReadOnly = submitted || !isPending;");
    expect(messageCardContent).not.toContain('const isAnswered = submitted || !isPending;');
  });

  it('shows a neutral closed state when question is no longer pending', () => {
    expect(messageCardContent).toContain("isAnswered ? 'Questions answered' : isPending ? 'Please answer to continue' : 'Question closed'");
    expect(messageCardContent).toContain('disabled={isReadOnly}');
  });
});
