import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppModule } from './app.module';
import { uploadsDir } from './common/upload/image-upload.config';

// Known example/placeholder secrets that appear verbatim in this repo's own
// .env.example, docker-compose.yml, and the CasaOS/ZimaOS app-store
// manifest (casaos/docker-compose.yml) — that manifest hardcodes a literal
// default value (CasaOS app-store installers pre-fill it and many
// non-technical self-hosters click through without changing it) rather
// than failing loudly the way `${JWT_SECRET:?...}` does in the main
// docker-compose.yml. This is a defense-in-depth backstop that applies to
// every deployment path, not just CasaOS: refuse to issue/verify sessions
// signed with a known-public or too-short secret instead of silently
// running with one an attacker can read directly from the public repo.
const KNOWN_PLACEHOLDER_JWT_SECRETS = new Set([
  'please-change-this-to-a-long-random-string',
  'change-me-to-a-long-random-string',
  'change-me',
  'changeme',
  'secret',
  'your-secret-here',
]);
const MIN_JWT_SECRET_LENGTH = 32;

// Where a self-generated secret is persisted so it survives container
// restarts/recreates — a dedicated volume, deliberately NOT under
// UPLOADS_DIR (that directory is served as static files at /api/uploads/,
// see below; a secret has no business living anywhere web-servable even
// if today's static middleware happens to ignore dotfiles).
const JWT_SECRET_STATE_FILE =
  process.env.JWT_SECRET_STATE_FILE ?? '/data/state/jwt-secret';

function isUsableSecret(secret: string): boolean {
  return (
    secret.length >= MIN_JWT_SECRET_LENGTH &&
    !KNOWN_PLACEHOLDER_JWT_SECRETS.has(secret.toLowerCase())
  );
}

// Resolves the JWT signing secret and returns it — also sets
// process.env.JWT_SECRET so every other module that reads it directly
// (auth.module.ts, jwt.strategy.ts, realtime.module.ts) sees the same
// value, since this runs before NestFactory.create() instantiates them.
//
// An explicit, valid JWT_SECRET env var always wins (the main
// docker-compose.yml enforces one via `${JWT_SECRET:?...}`, which fails at
// compose-parse time before the container even starts). Otherwise — most
// commonly a CasaOS/ZimaOS install, whose app-store manifest hardcodes a
// placeholder that most non-technical self-hosters never change — this
// generates a real random secret once and persists it, so the install
// just works with zero manual config instead of crash-looping with an
// opaque "Internal Server Error" the operator has no way to diagnose.
// Sessions stay valid across restarts because the same secret is reused
// from JWT_SECRET_STATE_FILE every time. Only if persistence itself is
// impossible (e.g. the volume isn't writable) does this still refuse to
// boot, as a last-resort safety net.
function resolveJwtSecret(): string {
  const envSecret = (process.env.JWT_SECRET ?? '').trim();
  if (isUsableSecret(envSecret)) {
    return envSecret;
  }

  try {
    if (existsSync(JWT_SECRET_STATE_FILE)) {
      const persisted = readFileSync(JWT_SECRET_STATE_FILE, 'utf8').trim();
      if (isUsableSecret(persisted)) {
        return persisted;
      }
    }
    const generated = randomBytes(32).toString('hex');
    mkdirSync(dirname(JWT_SECRET_STATE_FILE), { recursive: true });
    writeFileSync(JWT_SECRET_STATE_FILE, generated, { mode: 0o600 });
    console.warn(
      `JWT_SECRET was not set (or was a known placeholder) — generated a random one and saved it to ${JWT_SECRET_STATE_FILE}. ` +
        'It will be reused on every restart, so existing sessions stay valid. Set JWT_SECRET explicitly instead if you manage this deployment by hand.',
    );
    return generated;
  } catch (err) {
    console.error(
      `Refusing to start: JWT_SECRET is missing, a known placeholder value, or shorter than ${MIN_JWT_SECRET_LENGTH} characters, ` +
        `and a random one could not be generated/persisted at ${JWT_SECRET_STATE_FILE}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Set a real, unique, random JWT_SECRET (e.g. `openssl rand -hex 32`) before starting the backend — ' +
        'this protects every session this server will ever issue.',
    );
    process.exit(1);
  }
}

async function bootstrap() {
  process.env.JWT_SECRET = resolveJwtSecret();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  app.use(
    helmet({
      // Uploaded images are fetched cross-origin-ish (via the frontend's
      // same-origin /api proxy, but still through an <img> tag) — the
      // default helmet CORP header blocks that in some browsers.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());
  const origins = (process.env.CORS_ORIGIN ?? 'http://localhost:1995')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
  });
  app.setGlobalPrefix('api');
  app.useStaticAssets(uploadsDir(), { prefix: '/api/uploads/' });

  // Full route/schema map — genuinely useful in dev, but an unauthenticated
  // information-disclosure surface (every endpoint shape, DTO field, and
  // permission key) if left reachable in production. Opt in explicitly via
  // ENABLE_SWAGGER=true if a deployment wants it anyway (e.g. behind its
  // own reverse-proxy auth).
  if (
    process.env.NODE_ENV !== 'production' ||
    process.env.ENABLE_SWAGGER === 'true'
  ) {
    const config = new DocumentBuilder()
      .setTitle('OrderlyPOS API')
      .setDescription('REST API for the OrderlyPOS management system')
      .setVersion('1.0')
      .addCookieAuth('nodedr_session')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT ?? 4000;
  await app.listen(port, '0.0.0.0');
  console.log(
    `OrderlyPOS API listening on :${port} (docs at /api/docs)`,
  );
}
void bootstrap();
