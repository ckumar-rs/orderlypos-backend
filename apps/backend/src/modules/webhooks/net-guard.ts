// SSRF protection for webhook targets. A restaurant admin chooses the URL, so
// without this a malicious or compromised admin could make the server call
// internal services (cloud metadata, the database host, other containers).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
    });
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) takes the IPv4 rules.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // multicast
    return false;
  }
  return true; // not an IP at all: refuse
}

export interface WebhookNetOptions {
  allowPrivate: boolean;
  allowInsecure: boolean;
}

export function netOptionsFromEnv(env = process.env): WebhookNetOptions {
  return {
    allowPrivate: env.WEBHOOKS_ALLOW_PRIVATE === 'true',
    allowInsecure: env.WEBHOOKS_ALLOW_INSECURE === 'true',
  };
}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Parses and resolves a webhook URL, refusing non-HTTPS (unless allowed) and
 * any host that resolves to a private address. The returned address is what
 * the request must connect to, so DNS cannot change between this check and
 * the connection (DNS rebinding).
 */
export async function resolveWebhookTarget(
  raw: string,
  opts: WebhookNetOptions,
  resolve: (host: string) => Promise<{ address: string; family: number }[]> = (
    h,
  ) => lookup(h, { all: true }),
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL');
  }
  if (
    url.protocol !== 'https:' &&
    !(opts.allowInsecure && url.protocol === 'http:')
  )
    throw new Error('Webhook URLs must use https');
  if (url.username || url.password)
    throw new Error('Put credentials in the signature secret, not the URL');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolve(host).catch(() => {
        throw new Error('Could not resolve that host');
      });
  if (addresses.length === 0) throw new Error('Could not resolve that host');
  if (!opts.allowPrivate && addresses.some((a) => isPrivateAddress(a.address)))
    throw new Error('That address points to a private or internal network');

  const first = addresses[0];
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}
