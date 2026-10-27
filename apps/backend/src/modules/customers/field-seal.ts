import { createHash } from 'node:crypto';
import { openSecret, sealSecret } from '../../auth/totp';

const SEALED = /^v1\./;

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export function sealText(value: string | null | undefined, key: string): string | null {
  if (value == null || value === '') return value ?? null;
  if (SEALED.test(value) || !key) return value;
  return sealSecret(value, key);
}

export function openText(value: string | null | undefined, key: string): string | null {
  if (!value || !SEALED.test(value) || !key) return value ?? null;
  try {
    return openSecret(value, key);
  } catch {
    return value;
  }
}

const SEALED_FIELDS = ['email', 'address', 'notes', 'allergies'] as const;

export function sealCustomerFields<T extends Record<string, unknown>>(
  data: T,
  key: string,
): T & { emailLookup?: string | null } {
  const next = { ...data } as T & { emailLookup?: string | null };
  if ('email' in data) {
    const email = data.email;
    next.emailLookup =
      typeof email === 'string' && email.trim() ? hashEmail(email) : email == null ? null : undefined;
    if (typeof email === 'string' || email === null) {
      (next as unknown as Record<string, string | null | undefined>).email = sealText(
        email as string | null,
        key,
      );
    }
  }
  for (const field of SEALED_FIELDS) {
    if (field === 'email' || !(field in data)) continue;
    const value = data[field];
    if (typeof value === 'string' || value === null) {
      (next as Record<string, unknown>)[field] = sealText(value, key);
    }
  }
  return next;
}

export function openCustomerFields<T extends Record<string, unknown>>(row: T, key: string): T {
  const next = { ...row };
  for (const field of SEALED_FIELDS) {
    const value = next[field];
    if (typeof value === 'string') {
      (next as Record<string, unknown>)[field] = openText(value, key);
    }
  }
  return next;
}
