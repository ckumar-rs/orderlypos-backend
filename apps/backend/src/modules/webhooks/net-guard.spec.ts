import { isPrivateAddress, resolveWebhookTarget } from './net-guard';

const strict = { allowPrivate: false, allowInsecure: false };

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '203.0.113.9',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('refuses things that are not IPs', () =>
    expect(isPrivateAddress('example.com')).toBe(true));
});

describe('resolveWebhookTarget', () => {
  const publicDns = () =>
    Promise.resolve([{ address: '203.0.113.9', family: 4 }]);

  it('accepts an https URL on a public host and pins the address', async () => {
    const t = await resolveWebhookTarget(
      'https://hooks.example.com/in',
      strict,
      publicDns,
    );
    expect(t.address).toBe('203.0.113.9');
    expect(t.url.hostname).toBe('hooks.example.com');
  });

  it('rejects http unless explicitly allowed', async () => {
    await expect(
      resolveWebhookTarget('http://hooks.example.com', strict, publicDns),
    ).rejects.toThrow(/https/);
    await expect(
      resolveWebhookTarget(
        'http://hooks.example.com',
        { ...strict, allowInsecure: true },
        publicDns,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a hostname that resolves to an internal address (DNS-based SSRF)', async () => {
    const internal = () =>
      Promise.resolve([{ address: '169.254.169.254', family: 4 }]);
    await expect(
      resolveWebhookTarget('https://evil.example.com', strict, internal),
    ).rejects.toThrow(/private/);
  });

  it('rejects if ANY resolved address is internal', async () => {
    const mixed = () =>
      Promise.resolve([
        { address: '203.0.113.9', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
    await expect(
      resolveWebhookTarget('https://x.example.com', strict, mixed),
    ).rejects.toThrow(/private/);
  });

  it('rejects literal internal IPs, bracketed IPv6, credentials and junk', async () => {
    await expect(
      resolveWebhookTarget('https://127.0.0.1/x', strict),
    ).rejects.toThrow(/private/);
    await expect(
      resolveWebhookTarget('https://[::1]/x', strict),
    ).rejects.toThrow(/private/);
    await expect(
      resolveWebhookTarget('https://u:p@hooks.example.com', strict, publicDns),
    ).rejects.toThrow(/credentials/);
    await expect(resolveWebhookTarget('not a url', strict)).rejects.toThrow(
      /valid URL/,
    );
    await expect(
      resolveWebhookTarget('ftp://hooks.example.com', strict, publicDns),
    ).rejects.toThrow(/https/);
  });

  it('allows private targets only when the operator opts in (self-hosted LAN)', async () => {
    await expect(
      resolveWebhookTarget('http://192.168.1.50:5678/hook', {
        allowPrivate: true,
        allowInsecure: true,
      }),
    ).resolves.toMatchObject({ address: '192.168.1.50' });
  });
});
