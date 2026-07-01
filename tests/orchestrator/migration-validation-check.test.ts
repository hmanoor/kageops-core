/**
 * Migration validation check tests (G6).
 *
 * Covers the two MCC defects: an enum used without being declared (caught by a
 * fresh apply), and a password_hash seed under delegated auth (caught
 * statically). Plus the PGlite-apply guard that skips Supabase-isms so they
 * don't false-fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    discoverMigrationFiles,
    detectAuthModel,
    detectSeedAuthMismatch,
    pgliteApplyGuard,
    applyMigrationsToThrowawayDb,
    validateMigrations,
    formatMigrationWarning,
    type MigrationFile,
} from '../../src/orchestrator/migration-validation-check';

function mig(p: string, content: string): MigrationFile {
    return { path: p, content };
}

describe('discoverMigrationFiles()', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-mig-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds .sql under migration dirs, ordered, ignoring non-migration sql', () => {
        fs.mkdirSync(path.join(dir, 'drizzle'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'drizzle', '0001_b.sql'), 'SELECT 2;');
        fs.writeFileSync(path.join(dir, 'drizzle', '0000_a.sql'), 'SELECT 1;');
        // a stray query file outside a migration dir is ignored
        fs.writeFileSync(path.join(dir, 'queries.sql'), 'SELECT 99;');

        const files = discoverMigrationFiles(dir, fs);
        expect(files.map((f) => f.path)).toEqual(['drizzle/0000_a.sql', 'drizzle/0001_b.sql']);
    });

    it('returns nothing for a repo with no migration dirs', () => {
        fs.writeFileSync(path.join(dir, 'app.sql'), 'SELECT 1;');
        expect(discoverMigrationFiles(dir, fs)).toEqual([]);
    });
});

describe('detectAuthModel()', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-auth-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it.each([
        ['{"dependencies":{"@clerk/nextjs":"^6"}}', 'clerk'],
        ['{"dependencies":{"@supabase/supabase-js":"^2"}}', 'supabase'],
        ['{"dependencies":{"bcrypt":"^5"}}', 'custom'],
        ['{"dependencies":{"react":"^19"}}', 'unknown'],
    ])('detects %s → %s', (pkg, expected) => {
        fs.writeFileSync(path.join(dir, 'package.json'), pkg);
        expect(detectAuthModel(dir, fs)).toBe(expected);
    });
});

describe('detectSeedAuthMismatch()', () => {
    it('flags a password_hash seed under delegated auth (Clerk)', () => {
        const files = [mig('migrations/0001.sql', `INSERT INTO users (id, password_hash) VALUES (1, 'x');`)];
        const v = detectSeedAuthMismatch(files, 'clerk');
        expect(v).toHaveLength(1);
        expect(v[0].check).toBe('seed-auth-mismatch');
    });

    it('does not flag when the app rolls its own auth (custom)', () => {
        const files = [mig('migrations/0001.sql', `INSERT INTO users (id, password_hash) VALUES (1, 'x');`)];
        expect(detectSeedAuthMismatch(files, 'custom')).toHaveLength(0);
    });

    it('does not flag a password column with no seed insert', () => {
        const files = [mig('migrations/0001.sql', `CREATE TABLE users (id int, password_hash text);`)];
        expect(detectSeedAuthMismatch(files, 'clerk')).toHaveLength(0);
    });
});

describe('pgliteApplyGuard()', () => {
    it('marks plain DDL as safe', () => {
        expect(pgliteApplyGuard([mig('a.sql', 'CREATE TABLE t (id int);')]).safe).toBe(true);
    });

    it('skips RLS policies', () => {
        const g = pgliteApplyGuard([mig('a.sql', 'CREATE POLICY p ON t USING (true);')]);
        expect(g.safe).toBe(false);
        expect(g.reason).toContain('RLS');
    });

    it('skips Supabase auth-schema references', () => {
        expect(pgliteApplyGuard([mig('a.sql', 'ALTER TABLE t ADD col uuid REFERENCES auth.users(id);')]).safe).toBe(false);
    });

    it('skips an unsupported extension but allows vector', () => {
        expect(pgliteApplyGuard([mig('a.sql', 'CREATE EXTENSION postgis;')]).safe).toBe(false);
        expect(pgliteApplyGuard([mig('a.sql', 'CREATE EXTENSION IF NOT EXISTS vector;')]).safe).toBe(true);
    });
});

describe('applyMigrationsToThrowawayDb()', () => {
    it('applies a clean, correctly-ordered migration set', async () => {
        const files = [
            mig('0000.sql', `CREATE TYPE order_status AS ENUM ('pending', 'paid');`),
            mig('0001.sql', `CREATE TABLE orders (id integer PRIMARY KEY, status order_status NOT NULL);`),
        ];
        const result = await applyMigrationsToThrowawayDb(files);
        expect(result.ok).toBe(true);
    });

    it('fails on an undeclared enum (the MCC refund_status defect)', async () => {
        const files = [
            mig('0000.sql', `CREATE TABLE refunds (id integer PRIMARY KEY, status refund_status NOT NULL);`),
        ];
        const result = await applyMigrationsToThrowawayDb(files);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.file).toBe('0000.sql');
            expect(result.error.toLowerCase()).toContain('refund_status');
        }
    });

    it('fails on a forward reference (type declared in a later file)', async () => {
        const files = [
            mig('0000.sql', `CREATE TABLE orders (id integer PRIMARY KEY, status order_status NOT NULL);`),
            mig('0001.sql', `CREATE TYPE order_status AS ENUM ('pending');`),
        ];
        const result = await applyMigrationsToThrowawayDb(files);
        expect(result.ok).toBe(false);
    });
});

describe('validateMigrations() — end to end', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-migval-'));
        fs.mkdirSync(path.join(dir, 'drizzle'), { recursive: true });
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('passes a clean migration set with no violations', async () => {
        fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"@clerk/nextjs":"^6"}}');
        fs.writeFileSync(
            path.join(dir, 'drizzle', '0000_init.sql'),
            `CREATE TABLE posts (id integer PRIMARY KEY, title text NOT NULL);`,
        );
        const result = await validateMigrations(dir, fs);
        expect(result.applyStatus).toBe('passed');
        expect(result.violations).toEqual([]);
        expect(formatMigrationWarning(result)).toBeNull();
    });

    it('flags an undeclared enum via the fresh apply', async () => {
        fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"react":"^19"}}');
        fs.writeFileSync(
            path.join(dir, 'drizzle', '0000_init.sql'),
            `CREATE TABLE refunds (id integer PRIMARY KEY, status refund_status NOT NULL);`,
        );
        const result = await validateMigrations(dir, fs);
        expect(result.applyStatus).toBe('failed');
        expect(result.violations.some((v) => v.check === 'migration-apply-failed')).toBe(true);
        expect(formatMigrationWarning(result)).toContain('migration-apply-failed');
    });

    it('skips the apply for Supabase-ism migrations but still runs static checks', async () => {
        fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"@supabase/supabase-js":"^2"}}');
        fs.writeFileSync(
            path.join(dir, 'drizzle', '0000_init.sql'),
            `CREATE TABLE profiles (id uuid PRIMARY KEY, password_hash text);\n` +
                `INSERT INTO profiles (id, password_hash) VALUES ('00000000-0000-0000-0000-000000000001', 'x');\n` +
                `ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;`,
        );
        const result = await validateMigrations(dir, fs);
        expect(result.applyStatus).toBe('skipped');
        // static seed/auth check still fires
        expect(result.violations.some((v) => v.check === 'seed-auth-mismatch')).toBe(true);
    });

    it('returns no-migrations when there is nothing to validate', async () => {
        fs.rmSync(path.join(dir, 'drizzle'), { recursive: true, force: true });
        const result = await validateMigrations(dir, fs);
        expect(result.applyStatus).toBe('no-migrations');
        expect(result.migrationCount).toBe(0);
    });
});
