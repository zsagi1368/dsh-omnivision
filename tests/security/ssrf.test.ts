import { lookup } from 'node:dns/promises';
import { describe, expect, it, vi } from 'vitest';
import { assertSafeRemoteTarget, isPrivateOrReserved } from '../../src/security/index.ts';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => ({ address: '8.8.8.8', family: 4 })),
}));

const lookupMock = vi.mocked(lookup);

describe('isPrivateOrReserved', () => {
  it.each([
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12::34',
  ])('flags %s as private/reserved', (ip) => {
    expect(isPrivateOrReserved(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '999.1.1.1', 'example.com'])(
    'flags %s as public/unknown',
    (ip) => {
      expect(isPrivateOrReserved(ip)).toBe(false);
    },
  );
});

describe('assertSafeRemoteTarget', () => {
  it('resolves public targets and returns the parsed URL', async () => {
    const result = await assertSafeRemoteTarget('https://api.example.com/v1?x=1');
    expect(result.ip).toBe('8.8.8.8');
    expect(result.url.hostname).toBe('api.example.com');
    expect(result.url.protocol).toBe('https:');
  });

  it('throws SSRF_PRIVATE_IP when DNS resolves to a private address', async () => {
    lookupMock.mockResolvedValueOnce({ address: '10.0.0.5', family: 4 });
    await expect(assertSafeRemoteTarget('https://evil.example.com/x')).rejects.toThrow(
      'SSRF_PRIVATE_IP: 10.0.0.5',
    );
  });

  it('throws SSRF_DNS_FAILED when the DNS lookup fails', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertSafeRemoteTarget('https://missing.example.com/x')).rejects.toThrow(
      'SSRF_DNS_FAILED',
    );
  });

  it('rejects non-http protocols before any DNS lookup', async () => {
    lookupMock.mockClear();
    await expect(assertSafeRemoteTarget('ftp://example.com/file')).rejects.toThrow(
      'SSRF_UNSUPPORTED_PROTOCOL: ftp:',
    );
    await expect(assertSafeRemoteTarget('file:///etc/passwd')).rejects.toThrow(
      'SSRF_UNSUPPORTED_PROTOCOL: file:',
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
