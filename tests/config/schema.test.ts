import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type OmniVisionConfig, validateConfig } from '../../src/config/schema.ts';
import { captureEnv } from '../test-utils.ts';

function cloneConfig(): OmniVisionConfig {
  return structuredClone(DEFAULT_CONFIG);
}

describe('DEFAULT_CONFIG', () => {
  it('ships safe production defaults', () => {
    expect(DEFAULT_CONFIG.mode).toBe('auto');
    expect(DEFAULT_CONFIG.routing).toBe('pre-step');
    expect(DEFAULT_CONFIG.providers).toEqual([]);
    expect(DEFAULT_CONFIG.freeFallback).toBe(true);
    expect(DEFAULT_CONFIG.freeCloudFirst).toBe(false);
    expect(DEFAULT_CONFIG.freeZen).toEqual({
      enabled: true,
      model: 'big-pickle',
      apiKeyEnv: 'OPENCODE_API_KEY',
    });
    expect(DEFAULT_CONFIG.maxImageBytes).toBe(4 * 1024 * 1024);
    expect(DEFAULT_CONFIG.maxImagePixels).toBe(20_000_000);
    expect(DEFAULT_CONFIG.cache).toBe(true);
    expect(DEFAULT_CONFIG.cacheTtlSeconds).toBe(3600);
    expect(DEFAULT_CONFIG.cacheMaxEntries).toBe(200);
    expect(DEFAULT_CONFIG.timeoutMs).toBe(120_000);
    expect(DEFAULT_CONFIG.visionTaskTimeoutMs).toBe(45_000);
    expect(DEFAULT_CONFIG.language).toBe('zh');
    expect(DEFAULT_CONFIG.visionDepth).toBe('standard');
    expect(DEFAULT_CONFIG.progressiveTools).toBe(false);
    expect(DEFAULT_CONFIG.localOllama.baseURL).toBe('http://127.0.0.1:11434/v1');
    expect(DEFAULT_CONFIG.localLmStudio.baseURL).toBe('http://localhost:1234/v1');
  });
});

describe('validateConfig', () => {
  it('produces no warnings for the default config', () => {
    expect(validateConfig(cloneConfig())).toEqual([]);
  });

  it('warns when a provider apiKeyEnv is not set in the environment', () => {
    const restore = captureEnv(['OMNIVISION_UNSET_KEY']);
    try {
      delete process.env.OMNIVISION_UNSET_KEY;
      const config = cloneConfig();
      config.providers = [{ name: 'openai', apiKeyEnv: 'OMNIVISION_UNSET_KEY' }];
      expect(validateConfig(config)).toEqual([
        'Warning: OMNIVISION_UNSET_KEY not set in environment',
      ]);
    } finally {
      restore();
    }
  });

  it('does not warn when the referenced key is set', () => {
    const restore = captureEnv(['OMNIVISION_SET_KEY']);
    try {
      process.env.OMNIVISION_SET_KEY = 'some-value';
      const config = cloneConfig();
      config.providers = [{ name: 'openai', apiKeyEnv: 'OMNIVISION_SET_KEY' }];
      expect(validateConfig(config)).toEqual([]);
    } finally {
      restore();
    }
  });

  it('warns when enabled local backends point at non-local hosts', () => {
    const config = cloneConfig();
    config.localOllama.enabled = true;
    config.localOllama.baseURL = 'https://vision.example.com/v1';
    config.localLmStudio.enabled = true;
    config.localLmStudio.baseURL = 'http://8.8.8.8:1234/v1';
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('localOllama.baseURL (https://vision.example.com/v1)');
    expect(warnings[1]).toContain('localLmStudio.baseURL (http://8.8.8.8:1234/v1)');
  });

  it('treats unparsable baseURLs as non-local (warning)', () => {
    const config = cloneConfig();
    config.localOllama.enabled = true;
    config.localOllama.baseURL = '::::definitely-not-a-url';
    expect(validateConfig(config)).toHaveLength(1);
  });

  it('accepts loopback, localhost-like, .local and IPv6-local baseURLs without warnings', () => {
    const cases = [
      'http://127.0.0.1:11434/v1',
      'http://localhost:1234/v1',
      'http://api.localhost:1234/v1',
      'http://box.local:1234/v1',
      'http://[::1]:1234/v1',
      'http://192.168.1.10:1234/v1',
    ];
    for (const baseURL of cases) {
      const config = cloneConfig();
      config.localOllama.enabled = true;
      config.localOllama.baseURL = baseURL;
      expect(validateConfig(config)).toEqual([]);
    }
  });

  it('warns when maxImageBytes exceeds 25MB', () => {
    const config = cloneConfig();
    config.maxImageBytes = 26 * 1024 * 1024;
    expect(validateConfig(config)).toContain(
      'Warning: maxImageBytes > 25MB may cause memory issues',
    );
    const exact = cloneConfig();
    exact.maxImageBytes = 25 * 1024 * 1024;
    expect(validateConfig(exact)).toEqual([]);
  });

  it('warns when maxImagePixels exceeds 100MP', () => {
    const config = cloneConfig();
    config.maxImagePixels = 100_000_001;
    expect(validateConfig(config)).toContain('Warning: maxImagePixels > 100MP may cause OOM');
  });
});
