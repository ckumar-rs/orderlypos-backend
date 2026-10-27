import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Request } from 'express';
import { diskStorage, type FileFilterCallback } from 'multer';

// Persisted separately from the app's own image (a bind/named volume in
// docker-compose.yml) so uploaded menu photos survive container rebuilds,
// the same way the Postgres volume survives them — see README/ARCHITECTURE.
export function uploadsDir(): string {
  const dir = process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

export const imageUploadOptions = {
  storage: diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir()),
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${ALLOWED_EXTENSIONS.has(ext) ? ext : '.jpg'}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback,
  ) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) || !file.mimetype.startsWith('image/')) {
      cb(
        new BadRequestException(
          'Only image files (jpg, png, webp, gif) are allowed',
        ),
      );
      return;
    }
    cb(null, true);
  },
};

// Magic-byte signatures for the extensions ALLOWED_EXTENSIONS accepts.
// `fileFilter` above only sees the client-declared filename/mimetype
// (multer calls it before any bytes are read from a diskStorage upload) —
// neither is trustworthy. This checks the file actually on disk after
// multer finishes writing it, so a renamed/mislabeled non-image (e.g. an
// .html or .svg file saved as "photo.jpg" with a spoofed
// Content-Type: image/jpeg) is rejected and deleted rather than served
// back later under /api/uploads/.
const SIGNATURES: { match: (buf: Buffer) => boolean }[] = [
  { match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }, // JPEG
  {
    match: (b) =>
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  }, // PNG
  { match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 }, // GIF ("GIF")
  {
    match: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  }, // WEBP ("RIFF....WEBP")
];

export function assertValidImageSignature(filePath: string): void {
  let header: Buffer;
  try {
    header = readFileSync(filePath).subarray(0, 16);
  } catch {
    throw new BadRequestException('Uploaded file could not be read');
  }
  const isValidImage = SIGNATURES.some((sig) => sig.match(header));
  if (!isValidImage) {
    try {
      unlinkSync(filePath);
    } catch {
      // best-effort cleanup — the invalid file is at worst an orphaned,
      // non-executable, randomly-named blob under UPLOADS_DIR
    }
    throw new BadRequestException(
      'File content does not match a supported image format (jpg, png, webp, gif)',
    );
  }
}
