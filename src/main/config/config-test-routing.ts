import type { ApiTestInput, ApiTestResult } from '../../renderer/types';
import type { AppConfig } from './config-store';
import { testApiConnection } from './api-tester';
import { probeWithClaudeSdk } from '../claude/claude-sdk-one-shot';
import { isClaudeUnifiedModeEnabled } from '../session/claude-unified-mode';

export async function runConfigApiTest(
  payload: ApiTestInput,
  config: AppConfig,
  unifiedModeEnabled = isClaudeUnifiedModeEnabled()
): Promise<ApiTestResult> {
  if (unifiedModeEnabled) {
    return probeWithClaudeSdk(payload, config);
  }
  return testApiConnection(payload);
}
