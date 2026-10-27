import * as net from 'net';
import { probeNetworkPrinter, sendViaNetwork } from './escpos-network';
import { sendToBranchPrinter } from './printer-transport';
import { PrinterNotFoundError } from './escpos-usb';

function listen(onData: (b: Buffer) => void) {
  return new Promise<{ server: net.Server; port: number }>((resolve) => {
    const server = net.createServer((sock) => {
      const chunks: Buffer[] = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => onData(Buffer.concat(chunks)));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as net.AddressInfo).port }),
    );
  });
}

describe('network printer transport', () => {
  it('delivers the exact bytes to the printer', async () => {
    let got: Buffer = Buffer.alloc(0);
    const { server, port } = await listen((b) => (got = b));
    const payload = Buffer.from([0x1b, 0x40, 0x41, 0x42, 0x0a]);
    await sendViaNetwork({ host: '127.0.0.1', port }, payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.equals(payload)).toBe(true);
    server.close();
  });

  it('reports a refused connection as a clear printer error', async () => {
    const { server, port } = await listen(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await expect(
      sendViaNetwork({ host: '127.0.0.1', port }, Buffer.from('x')),
    ).rejects.toThrow(
      /Could not reach the printer at 127\.0\.0\.1:\d+.*refused/,
    );
    expect(await probeNetworkPrinter({ host: '127.0.0.1', port })).toEqual(
      expect.objectContaining({ reachable: false }),
    );
  });

  it('refuses network mode with no address instead of falling back to USB', async () => {
    await expect(
      sendToBranchPrinter(
        { printerConnection: 'NETWORK', printerHost: null, printerPort: 9100 },
        Buffer.from('x'),
      ),
    ).rejects.toBeInstanceOf(PrinterNotFoundError);
  });
});
