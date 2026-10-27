import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/** WebAuthn ES256 signatures are raw r||s. Node verifies DER. */
export function rawEs256ToDer(raw: Buffer): Buffer {
  if (raw.length !== 64) return raw;
  const encode = (part: Buffer) => {
    let value = part;
    let i = 0;
    while (i < value.length - 1 && value[i] === 0) i += 1;
    value = value.subarray(i);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const body = Buffer.concat([encode(raw.subarray(0, 32)), encode(raw.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export function authenticatorCounter(authenticatorData: Buffer): number {
  if (authenticatorData.length < 37) return 0;
  return authenticatorData.readUInt32BE(33);
}

export function verifyAssertion(input: {
  publicKeySpki: Buffer;
  authenticatorData: Buffer;
  clientDataJSON: Buffer;
  signature: Buffer;
}): boolean {
  const hash = createHash('sha256').update(input.clientDataJSON).digest();
  const signed = Buffer.concat([input.authenticatorData, hash]);
  const key: KeyObject = createPublicKey({ key: input.publicKeySpki, format: 'der', type: 'spki' });
  const signature =
    input.signature.length === 64 ? rawEs256ToDer(input.signature) : input.signature;
  return verify('sha256', signed, key, signature);
}

export function readClientData(clientDataJSON: Buffer): {
  type: string;
  challenge: string;
  origin: string;
} {
  const parsed = JSON.parse(clientDataJSON.toString('utf8')) as {
    type?: string;
    challenge?: string;
    origin?: string;
  };
  if (!parsed.type || !parsed.challenge || !parsed.origin) {
    throw new Error('Incomplete client data');
  }
  return { type: parsed.type, challenge: parsed.challenge, origin: parsed.origin };
}
