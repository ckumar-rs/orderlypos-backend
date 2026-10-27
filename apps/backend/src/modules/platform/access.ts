/** The address the API will actually compare. Prefers the first forwarded hop. */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  fallback = '',
): string {
  const raw = headers['x-forwarded-for'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const ip = (first?.split(',')[0] ?? fallback).trim();
  return ip.replace(/^::ffff:/, '');
}

/** An empty list allows every address. Otherwise the address must be listed. */
export function ipAllowed(list: string, ip: string): boolean {
  const rows = list
    .split(',')
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length === 0) return true;
  return rows.includes(ip);
}
