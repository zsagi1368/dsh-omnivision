import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OmniVisionConfig } from '../../src/config/schema.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { OmniVisionPlugin } from '../../src/plugin/index.ts';
import { captureEnv, cleanupDir, makeProvider, makeTempDir, okResult } from '../test-utils.ts';

let workspace: string;
let restoreEnv: () => void;

beforeEach(() => {
  workspace = makeTempDir('omnivision-comp-');
  restoreEnv = captureEnv(['ZAI_API_KEY', 'OPENCODE_API_KEY']);
  delete process.env.ZAI_API_KEY;
  delete process.env.OPENCODE_API_KEY;
});

afterEach(() => {
  restoreEnv();
  cleanupDir(workspace);
});

function makeConfig(
  overrides: Partial<OmniVisionConfig> = {},
  providers: OmniVisionConfig['providers'] = [],
): OmniVisionConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.providers = providers;
  Object.assign(config, overrides);
  return config;
}

function countProviders(config: OmniVisionConfig): number {
  return new OmniVisionPlugin({ config, workspace }).stats().providers;
}

describe('provider composition (free fallback tail)', () => {
  it('baseline: freeFallback with no keys yields exactly ovh', () => {
    expect(countProviders(makeConfig())).toBe(1);
  });

  it('+ZAI_API_KEY adds zhipu (2)', () => {
    process.env.ZAI_API_KEY = 'zai-test-key';
    expect(countProviders(makeConfig())).toBe(2);
  });

  it('+OPENCODE_API_KEY adds zen-free (3)', () => {
    process.env.ZAI_API_KEY = 'zai-test-key';
    process.env.OPENCODE_API_KEY = 'oc-test-key';
    expect(countProviders(makeConfig())).toBe(3);
  });

  it('freeCloudFirst changes ordering, not the count (3)', () => {
    process.env.ZAI_API_KEY = 'zai-test-key';
    process.env.OPENCODE_API_KEY = 'oc-test-key';
    expect(countProviders(makeConfig({ freeCloudFirst: true }))).toBe(3);
  });

  it('freeZen.enabled=false drops zen-free even with a key (back to 2)', () => {
    process.env.ZAI_API_KEY = 'zai-test-key';
    process.env.OPENCODE_API_KEY = 'oc-test-key';
    expect(
      countProviders(
        makeConfig({
          freeZen: { enabled: false, model: 'big-pickle', apiKeyEnv: 'OPENCODE_API_KEY' },
        }),
      ),
    ).toBe(2);
  });

  it('freeFallback=false removes the whole free tail (0)', () => {
    process.env.ZAI_API_KEY = 'zai-test-key';
    process.env.OPENCODE_API_KEY = 'oc-test-key';
    expect(countProviders(makeConfig({ freeFallback: false }))).toBe(0);
  });

  it('a custom freeZen apiKeyEnv is honored', () => {
    const restoreCustom = captureEnv(['OMNIVISION_CUSTOM_ZEN_KEY']);
    try {
      delete process.env.OMNIVISION_CUSTOM_ZEN_KEY;
      const config = makeConfig({
        freeZen: { enabled: true, model: 'other-model', apiKeyEnv: 'OMNIVISION_CUSTOM_ZEN_KEY' },
      });
      expect(countProviders(config)).toBe(1); // key absent -> no zen provider
      process.env.OMNIVISION_CUSTOM_ZEN_KEY = 'custom-key';
      expect(countProviders(config)).toBe(2);
    } finally {
      restoreCustom();
    }
  });
});

describe('provider composition (local backends)', () => {
  it('localOllama.enabled adds one provider', () => {
    expect(
      countProviders(
        makeConfig({
          localOllama: {
            enabled: true,
            baseURL: 'http://127.0.0.1:11434/v1',
            model: 'qwen2.5-vl:7b',
          },
        }),
      ),
    ).toBe(2);
  });

  it('localLmStudio.enabled adds one provider', () => {
    expect(
      countProviders(
        makeConfig({
          localLmStudio: {
            enabled: true,
            baseURL: 'http://localhost:1234/v1',
            model: 'qwen2.5-vl-7b',
          },
        }),
      ),
    ).toBe(2);
  });

  it('both local backends add two providers on top of the baseline', () => {
    expect(
      countProviders(
        makeConfig({
          localOllama: {
            enabled: true,
            baseURL: 'http://127.0.0.1:11434/v1',
            model: 'qwen2.5-vl:7b',
          },
          localLmStudio: {
            enabled: true,
            baseURL: 'http://localhost:1234/v1',
            model: 'qwen2.5-vl-7b',
          },
        }),
      ),
    ).toBe(3);
  });
});

describe('provider composition (named entries)', () => {
  it('named config.providers entries add one provider each', () => {
    expect(
      countProviders(
        makeConfig({ freeFallback: false }, [{ name: 'openai' }, { name: 'anthropic' }]),
      ),
    ).toBe(2);
  });

  it('ovh and ovh-free map to the ovh provider', () => {
    expect(
      countProviders(makeConfig({ freeFallback: false }, [{ name: 'ovh' }, { name: 'ovh-free' }])),
    ).toBe(2);
  });

  it('unknown names with a baseUrl become OpenAI-compatible providers', () => {
    expect(
      countProviders(
        makeConfig({ freeFallback: false }, [
          { name: 'myrelay', baseUrl: 'https://relay.example/v1' },
        ]),
      ),
    ).toBe(1);
  });

  it('unknown names without a baseUrl are ignored', () => {
    expect(countProviders(makeConfig({ freeFallback: false }, [{ name: 'mystery' }]))).toBe(0);
  });
});

describe('provider composition (extraProviders seam)', () => {
  it('extraProviders sit first and extend the chain', () => {
    const extra1 = makeProvider('extra-1', async () => okResult('one', 'extra-1'));
    const extra2 = makeProvider('extra-2', async () => okResult('two', 'extra-2'));
    const plugin = new OmniVisionPlugin({
      config: makeConfig({ freeFallback: false }),
      workspace,
      extraProviders: [extra1, extra2],
    });
    expect(plugin.stats().providers).toBe(2);
    expect(plugin.stats().circuit).toEqual({ blocked: [], total: 0 });
  });
});
