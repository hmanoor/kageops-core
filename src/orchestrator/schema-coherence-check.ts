/**
 * Schema-coherence check (P1-W4, first coherence-gate check).
 *
 * The Tier-3 benchmark ceiling in one symptom: the produced app kept the
 * nextjs-saas scaffold's boilerplate `users`/`memberships` tables and NEVER
 * added the brief's domain tables (bookmarks, sensors, sites, …). Every API
 * route and page that needed domain data then referenced a table that didn't
 * exist — an app that cannot possibly work, yet "the schema file exists" looked
 * like done.
 *
 * `ensureSchemaFirstSpine` (P0-W2) guarantees a schema *task* runs first; this
 * is the verification half: it flags a produced schema that still contains
 * ONLY the scaffold's boilerplate tables, so the acceptance-fix loop tells
 * Forge to add the domain tables. Deterministic, fs-injected, near-zero false
 * positives (it only fires when a real schema file exists and parses to a
 * non-empty table set that is a subset of the known boilerplate).
 */

import * as path from 'path';
import type * as FsType from 'fs';

type FsLike = Pick<typeof FsType, 'existsSync' | 'readFileSync'>;

export interface SchemaCoherenceViolation {
    readonly check: 'domain-schema-missing';
    readonly expected: string;
    readonly message: string;
}

/**
 * Tables the nextjs-saas scaffold ships. A produced schema whose table set is a
 * subset of these has had NO domain tables added. (The only DB-backed stack
 * bundle today; extend if another lands with different boilerplate.)
 */
export const SCAFFOLD_BOILERPLATE_TABLES: readonly string[] = ['users', 'memberships'];

/** Candidate Drizzle schema locations, in preference order. */
const SCHEMA_FILES: readonly string[] = ['lib/db/schema.ts', 'src/db/schema.ts', 'db/schema.ts'];

const PGTABLE_RE = /pgTable\(\s*['"`]([A-Za-z_]\w*)['"`]/g;

/** Extract the SQL table names declared via `pgTable('name', …)`. */
export function parsePgTableNames(source: string): readonly string[] {
    const names = new Set<string>();
    PGTABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PGTABLE_RE.exec(source)) !== null) {
        names.add(m[1].toLowerCase());
    }
    return [...names];
}

/**
 * Flag a DB-backed app whose Drizzle schema still contains only the scaffold's
 * boilerplate tables (no domain tables added). No-op for static sites (no
 * package.json), apps with no schema file, or an empty/unparseable schema.
 */
export function scanRepoForSchemaCoherence(
    repoPath: string,
    fs: FsLike,
    boilerplate: readonly string[] = SCAFFOLD_BOILERPLATE_TABLES,
): readonly SchemaCoherenceViolation[] {
    // Bundle apps only — a static site has no package.json / schema.
    if (!fs.existsSync(path.join(repoPath, 'package.json'))) return [];

    const schemaFile = SCHEMA_FILES
        .map((rel) => path.join(repoPath, rel))
        .find((abs) => fs.existsSync(abs));
    if (schemaFile === undefined) return [];

    let source: string;
    try {
        source = fs.readFileSync(schemaFile, 'utf-8');
    } catch {
        return [];
    }

    const tables = parsePgTableNames(source);
    if (tables.length === 0) return []; // nothing parsed — don't false-fail

    const boiler = new Set(boilerplate.map((t) => t.toLowerCase()));
    const domainTables = tables.filter((t) => !boiler.has(t));
    if (domainTables.length > 0) return [];

    return [
        {
            check: 'domain-schema-missing',
            expected: "the brief's domain tables added to the Drizzle schema + a migration",
            message:
                `The Drizzle schema defines only the scaffold's boilerplate tables ` +
                `(${tables.join(', ')}). No domain tables from the brief were added, so every ` +
                `API route and page that needs domain data will reference a table that does not ` +
                `exist. Add the domain tables to the schema and generate a migration.`,
        },
    ];
}
