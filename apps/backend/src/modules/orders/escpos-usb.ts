// Sends raw ESC/POS bytes (see escpos-receipt.ts) to a USB thermal receipt
// printer. Ported from nodedr-pos's backend/src/lib/escposUsb.js — same two
// transports, same order, same reasoning (see that file's history for the
// hardware lessons this encodes): kernel usblp character device first (the
// same path a plain `echo "hi" > /dev/usb/lp0` uses, and the only path that
// reaches vendor-class 80mm printers the kernel binds anyway), libusb raw
// bulk transfer as a fallback for setups where usblp isn't bound.
import { execFileSync } from 'child_process';
import * as fs from 'fs';

interface UsbModule {
  getDeviceList(): UsbDeviceLike[];
}

// Lazy, not a top-level `require('usb')`: this is a native addon, and its
// binding compatibility on a platform other than the Linux hosts this
// feature actually targets (see README's "Linux hosts only" note) is
// unverified — a top-level require would crash the whole backend process
// at boot if the native binding ever fails to load, instead of just this
// one printer feature being unavailable.
let usbModule: UsbModule | null | undefined;
function getUsb(): UsbModule | null {
  if (usbModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- `usb` has no usable ESM/TS types export shape for this narrow use
      usbModule = require('usb') as UsbModule;
    } catch {
      usbModule = null;
    }
  }
  return usbModule;
}

const PRINTER_INTERFACE_CLASS = 7;
const USBLP_MAJOR = 180; // major device number of the kernel usblp driver

export class PrinterNotFoundError extends Error {
  code = 'PRINTER_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'PrinterNotFoundError';
  }
}

// --- Transport 1: kernel usblp character device --------------------------

function candidateLpPaths(): string[] {
  const paths: string[] = [];
  for (let i = 0; i < 4; i++) paths.push(`/dev/usb/lp${i}`, `/dev/usblp${i}`);
  return paths;
}

// Prefers lp nodes already present; only when none exist does it try to
// create /dev/usb/lp{0..3} (major 180). Best-effort — with no privilege it
// simply returns whatever already exists and lets libusb take over. All
// mknod arguments are constant (no user input), so no shell-injection
// surface here.
function usableLpPaths(): string[] {
  const existing = candidateLpPaths().filter((p) => {
    try {
      return fs.statSync(p).isCharacterDevice();
    } catch {
      return false;
    }
  });
  if (existing.length > 0) return existing;

  const made: string[] = [];
  try {
    fs.mkdirSync('/dev/usb', { recursive: true });
    for (let minor = 0; minor < 4; minor++) {
      const target = `/dev/usb/lp${minor}`;
      try {
        execFileSync('mknod', [
          '-m',
          '660',
          target,
          'c',
          String(USBLP_MAJOR),
          String(minor),
        ]);
        made.push(target);
      } catch {
        // couldn't create this minor (already exists / not permitted)
      }
    }
  } catch {
    // no privilege even to mkdir — fall through with an empty list
  }
  return made;
}

const CHAR_WRITE_TIMEOUT_MS = 8000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`Timed out writing to ${label} — printer not responding`),
        ),
      ms,
    );
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

// Writes the buffer to the first usblp node backed by a real printer.
// Returns true on success; false when no node is backed by a printer
// (caller then tries libusb). A node that IS backed but errors mid-write
// (out of paper, etc.) throws.
async function sendViaCharDevice(buffer: Buffer): Promise<boolean> {
  const paths = usableLpPaths();
  let lastRealError: NodeJS.ErrnoException | null = null;
  for (const path of paths) {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(path, 'w');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && ['ENODEV', 'ENXIO', 'ENOENT', 'EACCES'].includes(code))
        continue;
      lastRealError = err as NodeJS.ErrnoException;
      continue;
    }
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await withTimeout(
          handle.write(buffer, offset, buffer.length - offset),
          CHAR_WRITE_TIMEOUT_MS,
          path,
        );
        if (bytesWritten <= 0) break;
        offset += bytesWritten;
      }
      return true;
    } finally {
      await handle.close().catch(() => {});
    }
  }
  if (lastRealError) throw lastRealError;
  return false;
}

// Proves each node is actually backed by a printer by briefly opening it for
// write — a node we mknod'd on demand but with no printer bound fails to
// open (ENODEV/ENXIO). Opening O_WRONLY writes nothing, so this is
// side-effect free.
export async function probeCharDevices(): Promise<string[]> {
  const out: string[] = [];
  for (const path of usableLpPaths()) {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(path, 'w');
      out.push(path);
    } catch {
      // node not backed by a printer
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }
  return out;
}

// --- Transport 2: libusb raw bulk ----------------------------------------

interface UsbDeviceLike {
  open(): void;
  close(): void;
  interfaces?: {
    descriptor: { bInterfaceClass: number };
    isKernelDriverActive(): boolean;
    detachKernelDriver(): void;
    attachKernelDriver(): void;
    claim(): void;
    release(closeEndpoints: boolean, cb: () => void): void;
    endpoints: {
      direction: string;
      timeout: number;
      transferAsync(buf: Buffer): Promise<void>;
    }[];
  }[];
  deviceDescriptor: { idVendor: number; idProduct: number };
}

function findPrinterInterface(): {
  device: UsbDeviceLike;
  iface: NonNullable<UsbDeviceLike['interfaces']>[number];
} | null {
  const usb = getUsb();
  if (!usb) return null;
  for (const device of usb.getDeviceList()) {
    let opened = false;
    try {
      device.open();
      opened = true;
      const iface = (device.interfaces || []).find(
        (i) => i.descriptor.bInterfaceClass === PRINTER_INTERFACE_CLASS,
      );
      if (iface) return { device, iface };
      device.close();
    } catch {
      if (opened) {
        try {
          device.close();
        } catch {
          // already gone
        }
      }
    }
  }
  return null;
}

function detachKernelDriver(
  iface: NonNullable<UsbDeviceLike['interfaces']>[number],
): boolean {
  try {
    if (iface.isKernelDriverActive()) {
      iface.detachKernelDriver();
      return true;
    }
  } catch {
    // not supported / already detached
  }
  return false;
}

async function sendViaLibusb(buffer: Buffer): Promise<boolean> {
  const found = findPrinterInterface();
  if (!found) return false;
  const { device, iface } = found;
  const reattach = detachKernelDriver(iface);
  try {
    try {
      iface.claim();
    } catch (err) {
      if (
        /LIBUSB_ERROR_BUSY|EBUSY|resource busy/i.test(
          String((err as Error)?.message),
        )
      ) {
        throw new PrinterNotFoundError(
          'The USB printer is busy — another program (or the OS print queue) is using it. Close it and try again.',
        );
      }
      throw err;
    }
    const outEndpoint = iface.endpoints.find((e) => e.direction === 'out');
    if (!outEndpoint) {
      throw new Error(
        'USB printer has no OUT endpoint on its printer-class interface',
      );
    }
    outEndpoint.timeout = 5000;
    await outEndpoint.transferAsync(buffer);
  } finally {
    await new Promise<void>((resolve) => iface.release(true, () => resolve()));
    if (reattach) {
      try {
        iface.attachKernelDriver();
      } catch {
        // best-effort — restores /dev/usb/lp0 for the OS print path
      }
    }
    try {
      device.close();
    } catch {
      // already closed/gone
    }
  }
  return true;
}

export function findPrinterDescriptor(): {
  vendorId: number;
  productId: number;
  id: string;
} | null {
  const found = findPrinterInterface();
  if (!found) return null;
  const d = found.device.deviceDescriptor;
  try {
    found.device.close();
  } catch {
    // already gone
  }
  return {
    vendorId: d.idVendor,
    productId: d.idProduct,
    id: `${d.idVendor.toString(16).padStart(4, '0')}:${d.idProduct.toString(16).padStart(4, '0')}`,
  };
}

// --- Public API ------------------------------------------------------------

// Tries the kernel char device first (matches a working `echo > /dev/usb/lp0`
// and handles vendor-class printers), then libusb. Throws
// PrinterNotFoundError only when neither transport can reach a printer.
export async function sendRaw(buffer: Buffer): Promise<void> {
  let charDeviceError: Error | null = null;
  try {
    if (await sendViaCharDevice(buffer)) return;
  } catch (err) {
    charDeviceError = err as Error;
  }

  // A concrete libusb failure (busy, no endpoint, etc.) propagates as-is —
  // it's more useful to the caller than the generic char-device error below.
  if (await sendViaLibusb(buffer)) return;

  if (charDeviceError) {
    throw new PrinterNotFoundError(
      'Found a printer device but could not write to it. Check it is powered on, has paper, and is connected.',
    );
  }
  throw new PrinterNotFoundError(
    'No USB printer found. Check it is powered on, connected, and not in use by another app.',
  );
}
