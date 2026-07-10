/**
 * P1-W4 (first coherence check) — schema-coherence.
 *
 * The benchmark failure that defined the Tier-3 ceiling: the produced app kept
 * the nextjs-saas scaffold's boilerplate `users`/`memberships` tables and never
 * added the brief's domain tables, so every API route and page that needed
 * domain data referenced a table that didn't exist. `ensureSchemaFirstSpine`
 * (P0-W2) guarantees a schema *task* runs first; this check VERIFIES the schema
 * task actually added domain tables — and drives an acceptance-fix repair when
 * it didn't.
 */
import { describe, it, expect } from 'vitest';
import {
    scanRepoForSchemaCoherence,
    parsePgTableNames,
    SCAFFOLD_BOILERPLATE_TABLES,
} from '../../src/orchestrator/schema-coherence-check';

/** Minimal fake fs: a map of relative-path → contents. */
function fakeFs(files: Record<string, string>) {
    const has = (abs: string): boolean =>
        Object.keys(files).some((rel) => abs.replace(/\\/g, '/').endsWith(rel));
    return {
        existsSync: (abs: string): boolean => has(abs),
        readFileSync: (abs: string): string => {
            const key = Object.keys(files).find((rel) => abs.replace(/\\/g, '/').endsWith(rel));
            if (key === undefined) throw new Error(`ENOENT ${abs}`);
            return files[key];
        },
    } as unknown as typeof import('fs');
}

const SCHEMA_BOILERPLATE = `
export const users = pgTable('users', { id: text('id') });
export const memberships = pgTable('memberships', { id: text('id') });
`;

describe('parsePgTableNames', () => {
    it('extracts the SQL table names from pgTable() calls', () => {
        expect(parsePgTableNames(SCHEMA_BOILERPLATE).sort()).toEqual(['memberships', 'users']);
    });
    it('returns [] when there are no pgTable calls', () => {
        expect(parsePgTableNames('export const x = 1;')).toEqual([]);
    });
});

describe('scanRepoForSchemaCoherence (P1-W4)', () => {
    it('is a no-op when there is no package.json (static site)', () => {
        const fs = fakeFs({ 'lib/db/schema.ts': SCHEMA_BOILERPLATE });
        expect(scanRepoForSchemaCoherence('/repo', fs)).toEqual([]);
    });

    it('is a no-op when there is no schema file', () => {
        const fs = fakeFs({ 'package.json': '{}' });
        expect(scanRepoForSchemaCoherence('/repo', fs)).toEqual([]);
    });

    it('FLAGS a schema that still contains ONLY the scaffold boilerplate tables', () => {
        const fs = fakeFs({ 'package.json': '{}', 'lib/db/schema.ts': SCHEMA_BOILERPLATE });
        const violations = scanRepoForSchemaCoherence('/repo', fs);
        expect(violations).toHaveLength(1);
        expect(violations[0].check).toBe('domain-schema-missing');
        expect(violations[0].message).toMatch(/domain tables/i);
    });

    it('passes when a domain table has been added alongside the boilerplate', () => {
        const withDomain = SCHEMA_BOILERPLATE + `\nexport const bookmarks = pgTable('bookmarks', { id: text('id') });`;
        const fs = fakeFs({ 'package.json': '{}', 'lib/db/schema.ts': withDomain });
        expect(scanRepoForSchemaCoherence('/repo', fs)).toEqual([]);
    });

    it('does not false-fail on an empty / unparseable schema', () => {
        const fs = fakeFs({ 'package.json': '{}', 'lib/db/schema.ts': '// TODO: define schema' });
        expect(scanRepoForSchemaCoherence('/repo', fs)).toEqual([]);
    });

    it('exposes the boilerplate table set it compares against', () => {
        expect([...SCAFFOLD_BOILERPLATE_TABLES].sort()).toEqual(['memberships', 'users']);
    });
});
