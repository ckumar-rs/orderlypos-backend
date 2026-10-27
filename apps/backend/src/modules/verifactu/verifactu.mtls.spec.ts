// Proves the client really presents the .p12 certificate (mutual TLS) and parses the SOAP answer, against a
// local HTTPS server that insists on a client certificate. AEAT itself is not contacted.
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';
import { postSoap } from './verifactu.aeat';

function makeCert(cn: string, san?: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 30);
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  if (san)
    cert.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 2, value: san }] },
    ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keys,
    cert,
    pem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

describe('mutual TLS client', () => {
  jest.setTimeout(60_000);
  it('presents the taxpayer certificate and reads the answer', async () => {
    const server = makeCert('localhost', 'localhost');
    const client = makeCert('TAXPAYER SL B12345678');
    const p12 = Buffer.from(
      forge.asn1
        .toDer(
          forge.pkcs12.toPkcs12Asn1(
            client.keys.privateKey,
            [client.cert],
            'pw',
          ),
        )
        .getBytes(),
      'binary',
    );
    let seenCn = '';
    let seenBody = '';
    const srv = https.createServer(
      {
        key: server.keyPem,
        cert: server.pem,
        requestCert: true,
        rejectUnauthorized: false,
        ca: [client.pem],
      },
      (req, res) => {
        const peer = (
          req.socket as unknown as {
            getPeerCertificate: () => { subject?: { CN?: string } };
          }
        ).getPeerCertificate();
        seenCn = peer.subject?.CN ?? '';
        let b = '';
        req.on('data', (c: Buffer) => (b += c.toString()));
        req.on('end', () => {
          seenBody = b;
          res.setHeader('Content-Type', 'text/xml');
          res.end(
            '<env:Envelope xmlns:env="x"><env:Body><r:RespuestaRegFactuSistemaFacturacion xmlns:r="y"><r:CSV>CSV9</r:CSV><r:TiempoEsperaEnvio>60</r:TiempoEsperaEnvio><r:EstadoEnvio>Correcto</r:EstadoEnvio></r:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>',
          );
        });
      },
    );
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const out = await postSoap(
        `https://localhost:${port}/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`,
        p12,
        'pw',
        '<x/>',
        { ca: server.pem },
      );
      expect(out.csv).toBe('CSV9');
      expect(out.state).toBe('Correcto');
      expect(seenCn).toBe('TAXPAYER SL B12345678');
      expect(seenBody).toContain('<soapenv:Body><x/></soapenv:Body>');
    } finally {
      srv.close();
    }
  });
});
