import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';

/**
 * Lazy Drizzle/Neon client.
 *
 * Eager (module-load-time) construction broke `next build` whenever
 * DATABASE_URL wasn't present in the build environment — `next build`
 * evaluates module top-level code during page-data collection, and any
 * page importing `db` would trip the missing-env throw. Vercel applies
 * `--env` at runtime, not build time, so the eager path failed the build
 * even when runtime env was set correctly.
 *
 * Wrapping in a function defers the env check + client construction until
 * the first query. Build-time page-data collection no longer crashes on a
 * secret-less host.
 */
type Database = NeonHttpDatabase<typeof schema>;

let _db: Database | null = null;

export function getDb(): Database {
  if (_db !== null) return _db;

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error(
      'DATABASE_URL is not set — copy .env.example to .env.local for local dev, ' +
        'or set --env DATABASE_URL=... on the Vercel deploy.'
    );
  }

  _db = drizzle(neon(connectionString), { schema });
  return _db;
}

export type DB = Database;

/**
 * Backwards-compat alias. Existing imports of `db` still work but the
 * actual client construction is now lazy (deferred to first use).
 *
 * @deprecated Prefer `getDb()` for explicit lazy access.
 */
export const db = new Proxy({} as Database, {
  get(_target, prop, receiver) {
    const client = getDb();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
