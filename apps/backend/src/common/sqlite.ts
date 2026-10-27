/** True when this process was started against a SQLite file. */
export function isSqlite() {
  return (process.env.DATABASE_URL ?? '').startsWith('file:');
}

/** Postgres list columns are JSON on SQLite. Missing values read as none. */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
