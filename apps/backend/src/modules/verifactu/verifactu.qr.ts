import QRCode from 'qrcode';

/** Inline SVG of a QR code (error correction M, as AEAT requires) at the given CSS size, e.g. "35mm". */
export function qrSvg(data: string, size: string): string {
  const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cells: string[] = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (qr.modules.get(x, y)) cells.push(`M${x},${y}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR tributario"><path d="${cells.join('')}" fill="#000"/></svg>`;
}
