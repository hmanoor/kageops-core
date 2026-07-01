/**
 * G6 — ship a CORRECT baseline migration in the nextjs-saas scaffold.
 *
 * The ClubHub OSS dogfood exposed the gap: the scaffold shipped `lib/db/schema.ts`
 * and the `db:generate`/`db:push` scripts but NO committed migration, and it
 * gitignored the whole `drizzle/` folder. With nothing to extend, the OSS model
 * invented a `0000` migration from scratch — and got it wrong (a stray `password`
 * column under Clerk-delegated auth, and a set that didn't apply on a fresh DB).
 * G6 (`validateMigrations`) correctly caught it, but the model couldn't self-fix.
 *
 * The durable fix: ship a correct, pre-generated baseline migration so the agent
 * EXTENDS it (`db:generate` → `0001_…`) instead of reinventing `0000`. These
 * tests lock that in:
 *   - the baseline SQL + drizzle meta are present and declared in bundle.yaml,
 *   - it carries NO password column and NO seed inserts,
 *   - it APPLIES clean on a fresh PGlite and passes the real G6 gate,
 *   - it actually copies into a generated workspace,
 *   - drizzle/ is no longer gitignored (migrations are the committed source of truth).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadBundles } from '../../src/bundles/bundle-loader';
import { copyBundleScaffold } from '../../src/bundles/scaffold-copier';
import { validateMigrations, detectAuthModel } from '../../src/orchestrator/migration-validation-check';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLES_ROOT = path.join(REPO_ROOT, 'bundles');
const BUNDLE = path.join(BUNDLES_ROOT, 'stacks', 'nextjs-saas');
const SCAFFOLD = path.join(BUNDLE, 'scaffold');
const TEST_HOST_VERSION = '0.3.0';

function readScaffold(rel: string): string {
    return fs.readFileSync(path.join(SCAFFOLD, rel), 'utf-8');
}

describe('G6 — nextjs-saas baseline migration', () => {
    it('ships a committed baseline migration + drizzle meta', () => {
        expect(fs.existsSync(path.join(SCAFFOLD, 'drizzle', '0000_init.sql'))).toBe(true);
        expect(fs.existsSync(path.join(SCAFFOLD, 'drizzle', 'meta', '_journal.json'))).toBe(true);
        expect(fs.existsSync(path.join(SCAFFOLD, 'drizzle', 'meta', '0000_snapshot.json'))).toBe(true);
    });

    it('declares the baseline migration in bundle.yaml so it copies into workspaces', () => {
        const manifest = fs.readFileSync(path.join(BUNDLE, 'bundle.yaml'), 'utf-8');
        expect(manifest).toContain('scaffold/drizzle/0000_init.sql');
        expect(manifest).toContain('scaffold/drizzle/meta/_journal.json');
        expect(manifest).toContain('scaffold/drizzle/meta/0000_snapshot.json');
    });

    it('creates the Clerk-keyed tables with NO password column and NO seed inserts', () => {
        const sql = readScaffold(path.join('drizzle', '0000_init.sql'));
        expect(sql).toMatch(/create table "memberships"/i);
        expect(sql).toMatch(/create table "users"/i);
        expect(sql).toMatch(/"clerk_id"/i);
        // Delegated auth — never a password column, never seeded users.
        expect(sql).not.toMatch(/\b(password|password_hash|password_digest|hashed_password)\b/i);
        expect(sql).not.toMatch(/\binsert\s+into\b/i);
    });

    it('the scaffold no longer gitignores the drizzle/ migration folder', () => {
        const gitignore = readScaffold('.gitignore');
        // The old `drizzle/` ignore line is gone — migrations are committed.
        const ignoresDrizzle = gitignore
            .split('\n')
            .some((line) => line.trim() === 'drizzle/');
        expect(ignoresDrizzle).toBe(false);
    });

    it('exposes a db:migrate script to apply committed migrations', () => {
        const pkg = JSON.parse(readScaffold('package.json')) as {
            scripts?: Record<string, string>;
        };
        expect(pkg.scripts?.['db:migrate']).toBe('drizzle-kit migrate');
    });

    it('passes the real G6 gate — applies clean on a fresh PGlite, zero violations', async () => {
        // detectAuthModel reads the scaffold package.json deps (@clerk/*).
        expect(detectAuthModel(SCAFFOLD, fs)).toBe('clerk');

        const result = await validateMigrations(SCAFFOLD, fs);
        expect(result.migrationCount).toBeGreaterThanOrEqual(1);
        expect(result.applyStatus).toBe('passed');
        expect(result.violations).toEqual([]);
    });

    it('AGENTS.md tells the agent to extend the baseline, not reinvent 0000', () => {
        const agents = readScaffold('AGENTS.md');
        expect(agents).toContain('drizzle/0000_init.sql');
        expect(agents).toMatch(/db:generate/);
        expect(agents).toMatch(/never.*recreate.*0000|don't reinvent/i);
    });

    describe('copyBundleScaffold ships the migration into a workspace', () => {
        let workDir: string;
        beforeEach(() => {
            workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-g6-'));
        });
        afterEach(() => {
            fs.rmSync(workDir, { recursive: true, force: true });
        });

        it('copies drizzle/0000_init.sql + meta byte-intact into the generated app', async () => {
            const loaded = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
            const nextjs = loaded.bundles.find((b) => b.manifest.name === 'nextjs-saas');
            expect(nextjs).toBeDefined();

            const copy = await copyBundleScaffold({
                bundle: nextjs!,
                destDir: workDir,
                vars: { title: 'Chess Club', description: 'Membership site' },
            });
            // copyBundleScaffold always reports forward-slashed workspace paths.
            expect(copy.filesCopied).toContain('drizzle/0000_init.sql');

            // The migration that lands in the workspace still applies clean on a
            // fresh DB through the real G6 gate.
            const result = await validateMigrations(workDir, fs);
            expect(result.applyStatus).toBe('passed');
            expect(result.violations).toEqual([]);
        });
    });
});
