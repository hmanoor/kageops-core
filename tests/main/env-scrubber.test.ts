/**
 * env-scrubber unit tests (bug #6 — v0.1.32)
 *
 * The scrubber's contract is narrow: only KAGEOPS_DATA_DIR and
 * KAGEOPS_PROJECTS_DIR, only when the value is the legacy pre-F-382 literal
 * OR points at a directory that doesn't exist. Everything else in the .env
 * (Google OAuth secrets, provider keys, custom keys) is preserved byte-for-
 * byte. These tests pin that contract because the operator's .env is the
 * one file we absolutely cannot trash.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { scrubStaleEnvFile, decideScrubReason } from '../../src/main/env-scrubber';

describe('decideScrubReason', () => {
    it('flags the legacy Windows literal path', () => {
        expect(
            decideScrubReason('C:\\projects\\playground\\kageops\\projects\\data'),
        ).toMatch(/legacy default path/);
        expect(
            decideScrubReason('C:/projects/playground/kageops/projects'),
        ).toMatch(/legacy default path/);
    });

    it('is case-insensitive on the legacy literal', () => {
        expect(
            decideScrubReason('c:\\projects\\Playground\\KageOps\\Projects\\data'),
        ).toMatch(/legacy default path/);
    });

    it('does NOT flag a non-existent path (#163 — narrowed in v0.1.41)', () => {
        // Pre-v0.1.41 this branch returned 'target directory does not exist',
        // which silently wiped legitimately-saved KAGEOPS_PROJECTS_DIR values
        // on every boot. v0.1.41 narrowed the scrubber to legacy-literal
        // matches only. Custom paths — existing or not — are now preserved.
        const fake = path.join(os.tmpdir(), 'kageops-scrub-test-does-not-exist-' + Date.now());
        expect(decideScrubReason(fake)).toBeNull();
    });

    it('flags empty values', () => {
        expect(decideScrubReason('')).toMatch(/empty/);
    });

    it('keeps a healthy override pointing at a real directory', () => {
        const real = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-scrub-real-'));
        try {
            expect(decideScrubReason(real)).toBeNull();
        } finally {
            fs.rmSync(real, { recursive: true, force: true });
        }
    });
});

describe('scrubStaleEnvFile', () => {
    let tmpDir: string;
    let envPath: string;
    const originalDataDir = process.env['KAGEOPS_DATA_DIR'];
    const originalProjectsDir = process.env['KAGEOPS_PROJECTS_DIR'];

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-scrub-'));
        envPath = path.join(tmpDir, '.env');
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
        if (originalDataDir === undefined) delete process.env['KAGEOPS_DATA_DIR'];
        else process.env['KAGEOPS_DATA_DIR'] = originalDataDir;
        if (originalProjectsDir === undefined) delete process.env['KAGEOPS_PROJECTS_DIR'];
        else process.env['KAGEOPS_PROJECTS_DIR'] = originalProjectsDir;
    });

    it('returns a clean no-op result when the file does not exist', () => {
        const missing = path.join(tmpDir, 'never-existed.env');
        const result = scrubStaleEnvFile(missing);
        expect(result).toEqual({ scrubbed: 0, details: [], fileExisted: false });
    });

    it('comments out the legacy Windows literal lines', () => {
        fs.writeFileSync(
            envPath,
            [
                'KAGEOPS_GOOGLE_CLIENT_ID=safe-keep-me',
                'KAGEOPS_GOOGLE_CLIENT_SECRET=GOCSPX-secret',
                'KAGEOPS_DATA_DIR=C:\\projects\\playground\\kageops\\projects\\data',
                'KAGEOPS_PROJECTS_DIR=C:\\projects\\playground\\kageops\\projects',
            ].join('\n'),
            'utf-8',
        );

        const result = scrubStaleEnvFile(envPath);

        expect(result.scrubbed).toBe(2);
        const after = fs.readFileSync(envPath, 'utf-8');
        // Untouched secrets
        expect(after).toContain('KAGEOPS_GOOGLE_CLIENT_ID=safe-keep-me');
        expect(after).toContain('KAGEOPS_GOOGLE_CLIENT_SECRET=GOCSPX-secret');
        // Scrubbed entries are commented with a tag + original value preserved
        expect(after).toMatch(/^# \[scrubbed by KageOps v0\.1\.32 — .*\] KAGEOPS_DATA_DIR=/m);
        expect(after).toMatch(/^# \[scrubbed by KageOps v0\.1\.32 — .*\] KAGEOPS_PROJECTS_DIR=/m);
        // No active uncommented line for the scrubbed keys remains
        expect(after).not.toMatch(/^KAGEOPS_DATA_DIR=/m);
        expect(after).not.toMatch(/^KAGEOPS_PROJECTS_DIR=/m);
    });

    it('preserves custom paths even when the target directory does not exist (#163 regression guard)', () => {
        // Operator-observed v0.1.40 bug: configuring a custom
        // KAGEOPS_PROJECTS_DIR through the UI saved the value to .env,
        // but on next boot the env-scrubber wiped it because the dir
        // didn't yet exist. v0.1.41 narrowed the scrubber so custom
        // paths are kept regardless of on-disk presence. The companion
        // mkdir-on-save in config:save-env-var creates the directory
        // at save-time, so this case rarely fires in production — but
        // the regression guard locks in the no-wipe behaviour.
        const fake = path.join(tmpDir, 'a-path-the-user-saved-but-did-not-create');
        fs.writeFileSync(envPath, `KAGEOPS_PROJECTS_DIR=${fake}\n`, 'utf-8');
        const result = scrubStaleEnvFile(envPath);
        expect(result.scrubbed).toBe(0);
        const after = fs.readFileSync(envPath, 'utf-8');
        expect(after).toContain(`KAGEOPS_PROJECTS_DIR=${fake}`);
        expect(after).not.toMatch(/scrubbed by KageOps/);
    });

    it('leaves a healthy override pointing at a real directory alone', () => {
        const real = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-scrub-keepme-'));
        try {
            fs.writeFileSync(envPath, `KAGEOPS_DATA_DIR=${real}\n`, 'utf-8');
            const result = scrubStaleEnvFile(envPath);
            expect(result.scrubbed).toBe(0);
            expect(fs.readFileSync(envPath, 'utf-8')).toContain(`KAGEOPS_DATA_DIR=${real}`);
        } finally {
            fs.rmSync(real, { recursive: true, force: true });
        }
    });

    it('never touches keys outside the scrubbable allowlist', () => {
        fs.writeFileSync(
            envPath,
            [
                // These all point at non-existent dirs but they are NOT scrubbable keys
                'DATABASE_URL=postgres://does-not-matter/at-all',
                'OPENAI_API_KEY=sk-fake',
                'MY_CUSTOM_VAR=/definitely/not/here',
            ].join('\n'),
            'utf-8',
        );
        const result = scrubStaleEnvFile(envPath);
        expect(result.scrubbed).toBe(0);
        const after = fs.readFileSync(envPath, 'utf-8');
        expect(after).toContain('DATABASE_URL=postgres://does-not-matter/at-all');
        expect(after).toContain('OPENAI_API_KEY=sk-fake');
        expect(after).toContain('MY_CUSTOM_VAR=/definitely/not/here');
    });

    it('is idempotent — second run is a no-op', () => {
        fs.writeFileSync(
            envPath,
            'KAGEOPS_DATA_DIR=C:\\projects\\playground\\kageops\\projects\\data\n',
            'utf-8',
        );
        const first = scrubStaleEnvFile(envPath);
        expect(first.scrubbed).toBe(1);
        const second = scrubStaleEnvFile(envPath);
        expect(second.scrubbed).toBe(0);
    });

    it('strips matching values from process.env after scrubbing the file', () => {
        process.env['KAGEOPS_DATA_DIR'] = 'C:\\projects\\playground\\kageops\\projects\\data';
        fs.writeFileSync(
            envPath,
            'KAGEOPS_DATA_DIR=C:\\projects\\playground\\kageops\\projects\\data\n',
            'utf-8',
        );
        scrubStaleEnvFile(envPath);
        expect(process.env['KAGEOPS_DATA_DIR']).toBeUndefined();
    });

    it('preserves quoted legacy-literal values without doubling the quotes', () => {
        // v0.1.41 narrowed the scrubber to legacy-literal matches only, so
        // this test now uses the legacy literal pattern instead of a
        // non-existent path. The original quoted form is preserved in the
        // commented-out line so manual recovery / forensics stays trivial.
        const legacy = 'C:\\projects\\playground\\kageops\\projects\\data';
        fs.writeFileSync(envPath, `KAGEOPS_DATA_DIR="${legacy}"\n`, 'utf-8');
        const result = scrubStaleEnvFile(envPath);
        expect(result.scrubbed).toBe(1);
        const after = fs.readFileSync(envPath, 'utf-8');
        expect(after).toContain(`KAGEOPS_DATA_DIR="${legacy}"`);
    });

    it('ignores already-commented stale entries (no spurious double-commenting)', () => {
        const original =
            '# [scrubbed by KageOps v0.1.32 — legacy default path from pre-F-382 builds] KAGEOPS_DATA_DIR=C:\\projects\\playground\\kageops\\projects\\data\n';
        fs.writeFileSync(envPath, original, 'utf-8');
        const result = scrubStaleEnvFile(envPath);
        expect(result.scrubbed).toBe(0);
        expect(fs.readFileSync(envPath, 'utf-8')).toBe(original);
    });
});
