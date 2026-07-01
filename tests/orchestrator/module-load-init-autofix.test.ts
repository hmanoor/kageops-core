/**
 * BPF-27 — deploy-readiness auto-fix (defer eager module-load initializers).
 *
 * The decisive assertion in every rewrite test: feed the result back through the
 * REAL detector (`detectModuleLoadInit` / `scanRepoForModuleLoadInit`) and assert
 * zero findings. That guarantees the gate that flagged it now passes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectModuleLoadInit, scanRepoForModuleLoadInit } from '../../src/orchestrator/module-load-init-check';
import { deferModuleLoadInit, autofixRepoModuleLoadInit } from '../../src/orchestrator/module-load-init-autofix';

describe('deferModuleLoadInit — single-file rewrite', () => {
    it('defers the observed ClubHubOSS case: export const db = drizzle(neon(process.env...))', () => {
        const src = [
            `import { drizzle } from 'drizzle-orm/neon-http';`,
            `import { neon } from '@neondatabase/serverless';`,
            ``,
            `export const db = drizzle(neon(process.env.DATABASE_URL!));`,
            ``,
            `export async function POST() { return db.insert({}); }`,
        ].join('\n');

        // Sanity: the detector flags it before the fix.
        expect(detectModuleLoadInit(src, 'app/api/stripe/webhook/route.ts').length).toBeGreaterThan(0);

        const fixed = deferModuleLoadInit(src, 'app/api/stripe/webhook/route.ts');
        expect(fixed).not.toBeNull();
        // The detector is now clean — the gate would pass.
        expect(detectModuleLoadInit(fixed!, 'app/api/stripe/webhook/route.ts')).toEqual([]);
        // The public binding name is preserved (call sites keep working).
        expect(fixed).toContain('const db: ReturnType<typeof __kageopsLazyInit_db>');
        expect(fixed).toContain('new Proxy(');
        expect(fixed).toContain('export const db');
        // The original initializer survives verbatim inside the lazy body.
        expect(fixed).toContain('drizzle(neon(process.env.DATABASE_URL!))');
    });

    it('defers an eager `new Stripe(process.env.X!)` and keeps the export', () => {
        const src = `export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\n`;
        const fixed = deferModuleLoadInit(src, 'lib/pay.ts');
        expect(fixed).not.toBeNull();
        expect(detectModuleLoadInit(fixed!, 'lib/pay.ts')).toEqual([]);
        expect(fixed).toContain('export const stripe:');
    });

    it('preserves a NON-exported const (no stray export keyword)', () => {
        const src = `const db = drizzle(neon(process.env.DATABASE_URL!));\n`;
        const fixed = deferModuleLoadInit(src, 'lib/db.ts');
        expect(fixed).not.toBeNull();
        expect(detectModuleLoadInit(fixed!, 'lib/db.ts')).toEqual([]);
        expect(fixed).toMatch(/\nconst db: ReturnType/);
        expect(fixed).not.toMatch(/export const db:/);
    });

    it('handles a multi-line initializer', () => {
        const src = [
            `export const db = drizzle(`,
            `  neon(process.env.DATABASE_URL!),`,
            `  { schema },`,
            `);`,
        ].join('\n');
        const fixed = deferModuleLoadInit(src, 'lib/db.ts');
        expect(fixed).not.toBeNull();
        expect(detectModuleLoadInit(fixed!, 'lib/db.ts')).toEqual([]);
    });

    // ── things it must NOT touch ──────────────────────

    it('returns null for already-lazy code (no module-scope env construction)', () => {
        const src = [
            `let _db: unknown;`,
            `export function getDb() { return (_db ??= drizzle(neon(process.env.DATABASE_URL!))); }`,
        ].join('\n');
        expect(deferModuleLoadInit(src, 'lib/db.ts')).toBeNull();
    });

    it('does NOT wrap a function/arrow value (would break calling it)', () => {
        // The detector flags this brace-less arrow, but wrapping it in a value
        // Proxy would break `makeClient()`. The autofix must leave it for a human.
        const src = `export const makeClient = () => new Stripe(process.env.STRIPE_SECRET_KEY!);\n`;
        const before = detectModuleLoadInit(src, 'lib/pay.ts').length;
        expect(before).toBeGreaterThan(0);
        const fixed = deferModuleLoadInit(src, 'lib/pay.ts');
        // Either untouched (null) — never a value-Proxy over a function.
        expect(fixed).toBeNull();
    });

    it('does NOT touch a multi-declarator statement', () => {
        const src = `export const a = drizzle(neon(process.env.DATABASE_URL!)), b = 1;\n`;
        expect(deferModuleLoadInit(src, 'lib/db.ts')).toBeNull();
    });

    it('is idempotent — re-running on its own output is a no-op', () => {
        const src = `export const db = drizzle(neon(process.env.DATABASE_URL!));\n`;
        const once = deferModuleLoadInit(src, 'lib/db.ts');
        expect(once).not.toBeNull();
        expect(deferModuleLoadInit(once!, 'lib/db.ts')).toBeNull();
    });

    it('does not match constructions inside strings or comments', () => {
        const src = [
            `// export const db = drizzle(neon(process.env.DATABASE_URL!));`,
            `const note = "new Stripe(process.env.X!)";`,
        ].join('\n');
        expect(deferModuleLoadInit(src, 'lib/x.ts')).toBeNull();
    });
});

describe('autofixRepoModuleLoadInit — repo walk', () => {
    let repo: string;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bpf27-'));
    });
    afterEach(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('rewrites offending files in place and leaves the repo scan clean', () => {
        const routeDir = path.join(repo, 'app', 'api', 'stripe', 'webhook');
        fs.mkdirSync(routeDir, { recursive: true });
        const routeFile = path.join(routeDir, 'route.ts');
        fs.writeFileSync(
            routeFile,
            `export const db = drizzle(neon(process.env.DATABASE_URL!));\nexport async function POST() { return db; }\n`,
            'utf-8',
        );
        // a clean file that must be left untouched
        const cleanFile = path.join(repo, 'lib', 'util.ts');
        fs.mkdirSync(path.dirname(cleanFile), { recursive: true });
        fs.writeFileSync(cleanFile, `export function cn() { return 1; }\n`, 'utf-8');
        const cleanBefore = fs.readFileSync(cleanFile, 'utf-8');

        // Before: the repo scan flags the route.
        expect(scanRepoForModuleLoadInit(repo, fs).length).toBeGreaterThan(0);

        const result = autofixRepoModuleLoadInit(repo, fs);

        expect(result.filesFixed).toContain('app/api/stripe/webhook/route.ts');
        expect(result.remaining).toEqual([]);
        // After: the repo scan is clean.
        expect(scanRepoForModuleLoadInit(repo, fs)).toEqual([]);
        // The clean file is byte-identical.
        expect(fs.readFileSync(cleanFile, 'utf-8')).toBe(cleanBefore);
        // The route still exports `db`.
        expect(fs.readFileSync(routeFile, 'utf-8')).toContain('export const db');
    });

    it('skips test/spec files', () => {
        const t = path.join(repo, 'tests', 'db.test.ts');
        fs.mkdirSync(path.dirname(t), { recursive: true });
        const body = `export const db = drizzle(neon(process.env.DATABASE_URL!));\n`;
        fs.writeFileSync(t, body, 'utf-8');
        const result = autofixRepoModuleLoadInit(repo, fs);
        expect(result.filesFixed).toEqual([]);
        expect(fs.readFileSync(t, 'utf-8')).toBe(body);
    });
});
