/**
 * BPF-31 — build-only env placeholders for credential-free build verification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    existingEnvKeys,
    applyBuildEnvPlaceholders,
    ensureBuildEnvPlaceholders,
} from '../../src/orchestrator/build-env-placeholders';

const PLACEHOLDERS = {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_Y2xlcmsuZXhhbXBsZS5jb20k',
    CLERK_SECRET_KEY: 'sk_test_buildplaceholder01',
    DATABASE_URL: 'postgres://build:build@localhost:5432/build?sslmode=disable',
};

describe('existingEnvKeys', () => {
    it('extracts keys, ignoring comments and blanks', () => {
        const keys = existingEnvKeys('# c\nFOO=1\n\nexport BAR=2\nBAZ="x"\n');
        expect([...keys].sort()).toEqual(['BAR', 'BAZ', 'FOO']);
    });
    it('returns empty for null', () => {
        expect(existingEnvKeys(null).size).toBe(0);
    });
});

describe('applyBuildEnvPlaceholders', () => {
    it('adds all placeholders when .env.local is absent', () => {
        const r = applyBuildEnvPlaceholders(null, PLACEHOLDERS);
        expect(r).not.toBeNull();
        expect(r!.added.sort()).toEqual(
            ['CLERK_SECRET_KEY', 'DATABASE_URL', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'],
        );
        expect(r!.contents).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k');
        // URL contains '?' / '=' / ':' → quoted
        expect(r!.contents).toContain('DATABASE_URL="postgres://build:build@localhost:5432/build?sslmode=disable"');
    });

    it('NEVER overwrites a key the operator already supplied (real value wins)', () => {
        const existing = 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_realkey\n';
        const r = applyBuildEnvPlaceholders(existing, PLACEHOLDERS);
        expect(r).not.toBeNull();
        // only the two MISSING keys are added; the real Clerk key is untouched
        expect(r!.added).not.toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
        expect(r!.added.sort()).toEqual(['CLERK_SECRET_KEY', 'DATABASE_URL']);
        expect(r!.contents).toContain('pk_live_realkey');
        // exactly one publishable-key line (no duplicate)
        expect((r!.contents.match(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=/g) ?? []).length).toBe(1);
    });

    it('returns null when every placeholder key is already present', () => {
        const existing = Object.entries(PLACEHOLDERS).map(([k, v]) => `${k}=${v}`).join('\n');
        expect(applyBuildEnvPlaceholders(existing, PLACEHOLDERS)).toBeNull();
    });
});

describe('ensureBuildEnvPlaceholders (on disk)', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bpf31-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('writes a fresh .env.local with placeholders when none exists', async () => {
        const added = await ensureBuildEnvPlaceholders(dir, PLACEHOLDERS, fs);
        expect(added.length).toBe(3);
        const body = fs.readFileSync(path.join(dir, '.env.local'), 'utf-8');
        expect(body).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k');
    });

    it('appends only missing keys to an existing materialized .env.local', async () => {
        fs.writeFileSync(path.join(dir, '.env.local'), 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_real\n', 'utf-8');
        const added = await ensureBuildEnvPlaceholders(dir, PLACEHOLDERS, fs);
        expect(added.sort()).toEqual(['CLERK_SECRET_KEY', 'DATABASE_URL']);
        const body = fs.readFileSync(path.join(dir, '.env.local'), 'utf-8');
        expect(body).toContain('pk_live_real');
        expect((body.match(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=/g) ?? []).length).toBe(1);
    });

    it('is a no-op (returns []) when no placeholders are declared', async () => {
        expect(await ensureBuildEnvPlaceholders(dir, {}, fs)).toEqual([]);
        expect(fs.existsSync(path.join(dir, '.env.local'))).toBe(false);
    });
});
