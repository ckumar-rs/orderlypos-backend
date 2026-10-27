# OrderlyPOS API

NestJS API for the admin app and the kiosk. Host this repository on Render. The database is a Neon Postgres database.

Set these environment variables on the Render service before the first deploy:

- `DATABASE_URL` — Neon direct connection string, with `sslmode=require`
- `JWT_SECRET` — a long random string
- `CORS_ORIGIN` — the Vercel origins for the admin app and the website, separated by a comma
- `COOKIE_SECURE` — `true`

`render.yaml` builds the API and runs `prisma migrate deploy` on start.
