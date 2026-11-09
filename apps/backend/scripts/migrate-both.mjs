/**
 * Apply Prisma migrations to Neon (DATABASE_URL) and local Postgres
 * (LOCAL_DATABASE_URL). Neon is primary; local must stay schema-matched.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile(envPath);
const neonUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
const localUrl = process.env.LOCAL_DATABASE_URL || fileEnv.LOCAL_DATABASE_URL;

if (!neonUrl) {
  console.error("DATABASE_URL (Neon) is required");
  process.exit(1);
}
if (!localUrl) {
  console.error("LOCAL_DATABASE_URL is required so local stays in sync with Neon");
  process.exit(1);
}

function migrate(label, url) {
  console.log(`\n→ Migrating ${label}…`);
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "migrate", "deploy"],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) {
    console.error(`✗ ${label} migrate failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${label} up to date`);
}

migrate("Neon (preferred)", neonUrl);
migrate("Local Postgres", localUrl);
console.log("\nBoth databases are on the same migration set. App prefers Neon.");
