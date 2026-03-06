import type { ApiTestInput, ApiTestResult } from '../../renderer/types';
import type { AppConfig } from './config-store';
import { testApiConnection } from './api-tester';
import { probeWithClaudeSdk } from '../claude/claude-sdk-one-shot';
import { requiresUnifiedClaudeSdk, shouldUseUnifiedClaudeSdk } from '../session/claude-unified-mode';

export async function runConfigApiTest(
  payload: ApiTestInput,
  config: AppConfig,
  useClaudeSdk = shouldUseUnifiedClaudeSdk(payload)
): Promise<ApiTestResult> {
  if (useClaudeSdk || requiresUnifiedClaudeSdk(payload)) {
    return probeWithClaudeSdk(payload, config);
  }
  return testApiConnection(payload);
}
