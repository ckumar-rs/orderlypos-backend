import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { authenticatorCounter, rawEs256ToDer, verifyAssertion } from './webauthn';

describe('webauthn assertion', () => {
  it('verifies a P-256 signature the way a passkey sends it', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const authenticatorData = Buffer.alloc(37);
    authenticatorData.writeUInt32BE(4, 33);
    const clientDataJSON = Buffer.from('{"type":"webauthn.get","challenge":"abc","origin":"http://localhost:1995"}');
    const signed = Buffer.concat([
      authenticatorData,
      createHash('sha256').update(clientDataJSON).digest(),
    ]);
    const der = sign('sha256', signed, privateKey);
    expect(verifyAssertion({
      publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }),
      authenticatorData,
      clientDataJSON,
      signature: der,
    })).toBe(true);
    expect(authenticatorCounter(authenticatorData)).toBe(4);
    expect(rawEs256ToDer(Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2)])).readUInt8(0)).toBe(0x30);
  });
});
