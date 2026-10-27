// Picks the transport for a branch's thermal printer: USB attached to the
// machine running the backend, or a network printer over raw TCP.
import { sendViaNetwork } from './escpos-network';
import { PrinterNotFoundError, sendRaw } from './escpos-usb';

export interface BranchPrinterTarget {
  printerConnection: string;
  printerHost: string | null;
  printerPort: number;
}

export async function sendToBranchPrinter(
  branch: BranchPrinterTarget,
  buffer: Buffer,
): Promise<void> {
  if (branch.printerConnection === 'NETWORK') {
    if (!branch.printerHost) {
      throw new PrinterNotFoundError(
        'Network printing is selected but no printer address is set - add it in Settings > Printer',
      );
    }
    return sendViaNetwork(
      { host: branch.printerHost, port: branch.printerPort },
      buffer,
    );
  }
  return sendRaw(buffer);
}
