import { describe, expect, it } from 'vitest';
import { getKnownSecrets, redactSecrets, redactUrl } from '../../src/security/index.ts';
import { captureEnv } from '../test-utils.ts';

describe('redactSecrets', () => {
  it('redacts exact known secrets', () => {
    const secret = 'super-secret-value-xyz-123456';
    expect(redactSecrets(`Authorization failed for ${secret}`, [secret])).toBe(
      'Authorization failed for [REDACTED]',
    );
  });

  it('ignores known secrets that are too short (<= 3 chars)', () => {
    expect(redactSecrets('key abc end', ['abc'])).toBe('key abc end');
  });

  it('redacts sk- and pk- token shapes', () => {
    const token = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    expect(redactSecrets(`use ${token} now`)).toBe('use [REDACTED_KEY] now');
    expect(redactSecrets('pk-abcdefghijklmnopqrstuvwxyz012345')).toBe('[REDACTED_KEY]');
    // short garbage after sk- is left alone
    expect(redactSecrets('sk-short')).toBe('sk-short');
  });

  it('redacts Bearer tokens (case-insensitive prefix)', () => {
    expect(redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz1234')).toBe('Bearer [REDACTED]');
    // Replacement is the literal template, so any casing of the prefix
    // collapses to the canonical "Bearer [REDACTED]" form.
    expect(redactSecrets('bearer abcdefghijklmnopqrstuvwxyz1234')).toBe('Bearer [REDACTED]');
    expect(redactSecrets('BEARER abcdefghijklmnopqrstuvwxyz1234')).toBe('Bearer [REDACTED]');
  });

  it('redacts api_key style assignments', () => {
    expect(redactSecrets('api_key=abcdefghijklmnopqrstuvwxyz1234 here')).toBe(
      'api_key=[REDACTED] here',
    );
    expect(redactSecrets('"apiKey": "abcdefghijklmnopqrstuvwxyz1234"')).toContain(
      'api_key=[REDACTED]',
    );
  });

  it('redacts URL userinfo', () => {
    expect(redactSecrets('see https://user:password123@example.com/x')).toBe(
      'see https://***:***@example.com/x',
    );
  });

  it('leaves clean text untouched', () => {
    const text = 'provider openai responded in 120ms with model gpt-4o';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactUrl', () => {
  it('masks userinfo credentials', () => {
    expect(redactUrl('https://user:pass@example.com/path?q=1')).toBe(
      'https://***:***@example.com/path?q=1',
    );
    expect(redactUrl('http://alice@host.io/x')).toBe('http://***:***@host.io/x');
  });

  it('returns URLs without credentials unchanged', () => {
    expect(redactUrl('https://example.com/a')).toBe('https://example.com/a');
  });

  it('returns invalid URLs unchanged', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

describe('getKnownSecrets', () => {
  it('collects only long values of the known key env vars', () => {
    const restore = captureEnv([
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'ZAI_API_KEY',
    ]);
    try {
      process.env.OPENAI_API_KEY = 'sk-aaaaaaaaaaaaaaaaaaaa';
      process.env.ANTHROPIC_API_KEY = 'short'; // <= 10 chars: ignored
      delete process.env.GEMINI_API_KEY;
      process.env.ZAI_API_KEY = 'zai-bbbbbbbbbbbbbbbbbbbb';
      expect(getKnownSecrets()).toEqual(['sk-aaaaaaaaaaaaaaaaaaaa', 'zai-bbbbbbbbbbbbbbbbbbbb']);
    } finally {
      restore();
    }
  });
});
