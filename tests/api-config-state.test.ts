import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/renderer/types';
import {
  FALLBACK_PROVIDER_PRESETS,
  buildApiConfigSnapshot,
  isCustomAnthropicLoopbackGateway,
  profileKeyFromProvider,
  profileKeyToProvider,
} from '../src/renderer/hooks/useApiConfigState';

describe('api config state helpers', () => {
  it('maps provider/protocol to profile key and back', () => {
    expect(profileKeyFromProvider('openrouter')).toBe('openrouter');
    expect(profileKeyFromProvider('custom', 'openai')).toBe('custom:openai');
    expect(profileKeyToProvider('custom:anthropic')).toEqual({
      provider: 'custom',
      customProtocol: 'anthropic',
    });
  });

  it('loads existing profile values without overwriting them with defaults', () => {
    const config = {
      provider: 'custom',
      customProtocol: 'openai',
      activeProfileKey: 'custom:openai',
      apiKey: 'sk-active',
      baseUrl: 'https://custom-openai.example/v1',
      model: 'gpt-5.2-codex',
      openaiMode: 'responses',
      profiles: {
        'custom:openai': {
          apiKey: 'sk-custom-openai',
          baseUrl: 'https://custom-openai.example/v1',
          model: 'gpt-5.2-codex',
          openaiMode: 'responses',
        },
        'custom:anthropic': {
          apiKey: 'sk-custom-anthropic',
          baseUrl: 'https://custom-anthropic.example',
          model: 'glm-4.7',
          openaiMode: 'responses',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.activeProfileKey).toBe('custom:openai');
    expect(snapshot.profiles['custom:openai'].apiKey).toBe('sk-custom-openai');
    expect(snapshot.profiles['custom:openai'].baseUrl).toBe('https://custom-openai.example/v1');
    expect(snapshot.profiles['custom:anthropic'].apiKey).toBe('sk-custom-anthropic');
  });

  it('applies defaults only for missing profiles', () => {
    const config = {
      provider: 'openai',
      customProtocol: 'anthropic',
      activeProfileKey: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      openaiMode: 'responses',
      profiles: {
        openai: {
          apiKey: 'sk-openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.2',
          openaiMode: 'responses',
        },
      },
      isConfigured: true,
    } as AppConfig;

    const snapshot = buildApiConfigSnapshot(config, FALLBACK_PROVIDER_PRESETS);
    expect(snapshot.profiles.openai.apiKey).toBe('sk-openai');
    expect(snapshot.profiles.openrouter.baseUrl).toBe(FALLBACK_PROVIDER_PRESETS.openrouter.baseUrl);
    expect(snapshot.profiles['custom:anthropic'].model).toBe(FALLBACK_PROVIDER_PRESETS.custom.models[0]?.id);
  });

  it('detects local custom anthropic loopback gateway url', () => {
    expect(isCustomAnthropicLoopbackGateway('http://127.0.0.1:8082')).toBe(true);
    expect(isCustomAnthropicLoopbackGateway('http://localhost:8082')).toBe(true);
    expect(isCustomAnthropicLoopbackGateway('http://[::1]:8082')).toBe(true);
    expect(isCustomAnthropicLoopbackGateway('http://0.0.0.0:8082')).toBe(true);
    expect(isCustomAnthropicLoopbackGateway('https://proxy.example.com')).toBe(false);
  });
});
