/**
 * P2-04 — vercel-deployer unit tests.
 *
 * Covers:
 *   - loadVercelToken precedence: env → keychain → ~/.vercel/auth.json
 *   - extractPreviewUrl regex against realistic CLI output samples
 *   - runDeploy happy path + failure path with mocked spawn
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    extractPreviewUrl,
    loadVercelToken,
    runDeploy,
    buildDeployEnvArgs,
    type SpawnFn,
} from '../../src/deployers/vercel-deployer';

// ── extractPreviewUrl ──────────────────────────────────

describe('extractPreviewUrl()', () => {
    it('finds the canonical preview hostname pattern', () => {
        const sample =
            'Inspect: https://vercel.com/team/project/abc123 [200ms]\n' +
            'Preview: https://my-app-abc123-myteam.vercel.app [copied to clipboard] [3s]\n';
        expect(extractPreviewUrl(sample)).toBe('https://my-app-abc123-myteam.vercel.app');
    });

    it('matches a URL with a path after the host', () => {
        expect(
            extractPreviewUrl('https://foo-bar.vercel.app/some/path?x=1')
        ).toBe('https://foo-bar.vercel.app/some/path?x=1');
    });

    it('returns null when no vercel.app URL is present', () => {
        expect(extractPreviewUrl('Deploy failed: ENOENT')).toBeNull();
        expect(extractPreviewUrl('')).toBeNull();
    });

    it('does not match https://vercel.com (production-facing)', () => {
        // Inspect URL on vercel.com should NOT be returned as the preview URL.
        const out =
            'Inspect: https://vercel.com/team/project [100ms]\n' +
            'Preview: https://x-y.vercel.app\n';
        expect(extractPreviewUrl(out)).toBe('https://x-y.vercel.app');
    });
});

// ── loadVercelToken ────────────────────────────────────

describe('loadVercelToken()', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        delete process.env['KAGEOPS_VERCEL_TOKEN'];
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('returns the env var when set (highest precedence)', async () => {
        process.env['KAGEOPS_VERCEL_TOKEN'] = 'env-token-abc';
        const result = await loadVercelToken({
            getKeychainSecret: vi.fn(async () => 'keychain-should-be-ignored'),
            homeDir: () => '/fake-home',
        });
        expect(result).toEqual({ value: 'env-token-abc', origin: 'env' });
    });

    it('falls back to the OS keychain when env is unset', async () => {
        const getKeychainSecret = vi.fn(async () => 'keychain-token-xyz');
        const result = await loadVercelToken({
            getKeychainSecret,
            homeDir: () => '/fake-home',
        });
        expect(result).toEqual({ value: 'keychain-token-xyz', origin: 'keychain' });
        expect(getKeychainSecret).toHaveBeenCalledWith('kageops', 'vercel-token');
    });

    it('falls back to ~/.vercel/auth.json when env and keychain are both empty', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-vercel-deploy-'));
        try {
            fs.mkdirSync(path.join(tmpHome, '.vercel'), { recursive: true });
            fs.writeFileSync(
                path.join(tmpHome, '.vercel', 'auth.json'),
                JSON.stringify({ token: 'cli-auth-token-789' })
            );

            const result = await loadVercelToken({
                getKeychainSecret: async () => null,
                homeDir: () => tmpHome,
            });
            expect(result).toEqual({
                value: 'cli-auth-token-789',
                origin: 'vercel-auth-json',
            });
        } finally {
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    it('returns null when nothing is configured anywhere', async () => {
        const result = await loadVercelToken({
            getKeychainSecret: async () => null,
            homeDir: () => '/does/not/exist',
        });
        expect(result).toBeNull();
    });

    it('survives a keychain throw and falls through to vercel-auth-json', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-vercel-deploy-'));
        try {
            fs.mkdirSync(path.join(tmpHome, '.vercel'), { recursive: true });
            fs.writeFileSync(
                path.join(tmpHome, '.vercel', 'auth.json'),
                JSON.stringify({ token: 'survived-keychain-throw' })
            );

            const result = await loadVercelToken({
                getKeychainSecret: async () => {
                    throw new Error('keytar exploded');
                },
                homeDir: () => tmpHome,
            });
            expect(result?.value).toBe('survived-keychain-throw');
            expect(result?.origin).toBe('vercel-auth-json');
        } finally {
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    it('treats an auth.json without a token field as missing', async () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-vercel-deploy-'));
        try {
            fs.mkdirSync(path.join(tmpHome, '.vercel'), { recursive: true });
            fs.writeFileSync(
                path.join(tmpHome, '.vercel', 'auth.json'),
                JSON.stringify({ other: 'thing' })
            );

            const result = await loadVercelToken({
                getKeychainSecret: async () => null,
                homeDir: () => tmpHome,
            });
            expect(result).toBeNull();
        } finally {
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });
});

// ── buildDeployEnvArgs (BPF-5) ─────────────────────────

describe('buildDeployEnvArgs() — Windows shell quoting (BPF-5)', () => {
    const NEON = 'postgres://u:p@host/db?sslmode=require&channel_binding=require';

    it('passes values verbatim on POSIX (shell:false → no shell parsing)', () => {
        const args = buildDeployEnvArgs({ DATABASE_URL: NEON, CLERK_SECRET_KEY: 'sk_test_abc' }, false);
        expect(args).toEqual([
            '--env', `DATABASE_URL=${NEON}`,
            '--env', 'CLERK_SECRET_KEY=sk_test_abc',
        ]);
    });

    it('QUOTES values on Windows so cmd does not split a Neon URL on & (the BPF-5 bug)', () => {
        const args = buildDeployEnvArgs({ DATABASE_URL: NEON }, true);
        // The whole KEY=VALUE token is double-quoted; the & is now inside quotes.
        expect(args).toEqual(['--env', `"DATABASE_URL=${NEON}"`]);
        expect(args[1]).toContain('&channel_binding=require');
        expect(args[1]!.startsWith('"') && args[1]!.endsWith('"')).toBe(true);
    });

    it('throws on a newline value (both platforms)', () => {
        expect(() => buildDeployEnvArgs({ BAD: 'a\nb' }, false)).toThrow(/newline/);
        expect(() => buildDeployEnvArgs({ BAD: 'a\nb' }, true)).toThrow(/newline/);
    });

    it('throws on Windows when a value contains a double-quote (cannot be safely wrapped)', () => {
        expect(() => buildDeployEnvArgs({ BAD: 'has"quote' }, true)).toThrow(/double-quote/);
        // POSIX tolerates it (passed verbatim, no shell).
        expect(buildDeployEnvArgs({ OK: 'has"quote' }, false)).toEqual(['--env', 'OK=has"quote']);
    });

    it('returns an empty argv for an empty env map', () => {
        expect(buildDeployEnvArgs({}, true)).toEqual([]);
        expect(buildDeployEnvArgs({}, false)).toEqual([]);
    });
});

// ── runDeploy ─────────────────────────────────────────

interface FakeChild extends EventEmitter {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
}

describe('runDeploy()', () => {
    it('parses the preview URL from stdout on success (exit 0)', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            {
                cwd: '/fake/workspace',
                token: { value: 't', origin: 'env' },
            },
            spawnFn
        );

        // Drive the spawn lifecycle
        await Promise.resolve(); // give the listeners a tick to attach
        fakeChild.stdout.emit(
            'data',
            Buffer.from('Preview: https://my-app-xyz123-team.vercel.app\n')
        );
        fakeChild.emit('close', 0);

        const result = await promise;
        expect(result.status).toBe('success');
        expect(result.previewUrl).toBe('https://my-app-xyz123-team.vercel.app');
        expect(result.exitCode).toBe(0);
    });

    it('BPF-13: times out and kills the CLI if it hangs (no close emitted)', async () => {
        vi.useFakeTimers();
        try {
            const fakeChild = makeFakeChild();
            const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

            const promise = runDeploy(
                { cwd: '/x', token: { value: 't', origin: 'env' } },
                spawnFn
            );

            // Simulate the "Loading teams…" hang: emit some output, never close.
            await Promise.resolve();
            fakeChild.stdout.emit('data', Buffer.from('Loading teams…'));

            // Advance past the default 5-minute cap.
            await vi.advanceTimersByTimeAsync(300_000 + 10);

            const result = await promise;
            expect(result.status).toBe('failure');
            expect(result.exitCode).toBeNull();
            expect(fakeChild.kill).toHaveBeenCalled();
            expect(result.stderr).toMatch(/timed out/i);
            expect(result.stderr).toMatch(/KAGEOPS_VERCEL_SCOPE|VERCEL_ORG_ID/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('BPF-13: a normal close before the timeout still resolves normally (no kill)', async () => {
        vi.useFakeTimers();
        try {
            const fakeChild = makeFakeChild();
            const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

            const promise = runDeploy(
                { cwd: '/x', token: { value: 't', origin: 'env' } },
                spawnFn
            );
            await Promise.resolve();
            fakeChild.stdout.emit('data', Buffer.from('https://app-abc-team.vercel.app\n'));
            fakeChild.emit('close', 0);

            const result = await promise;
            expect(result.status).toBe('success');
            expect(fakeChild.kill).not.toHaveBeenCalled();
            // Timer must be cleared — advancing time does nothing further.
            await vi.advanceTimersByTimeAsync(300_000 + 10);
            expect(result.previewUrl).toBe('https://app-abc-team.vercel.app');
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns failure when exit code is non-zero', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            { cwd: '/x', token: { value: 't', origin: 'env' } },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stderr.emit('data', Buffer.from('Error: invalid token'));
        fakeChild.emit('close', 1);

        const result = await promise;
        expect(result.status).toBe('failure');
        expect(result.previewUrl).toBeUndefined();
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('invalid token');
    });

    it('returns failure when exit code is 0 but no preview URL is found', async () => {
        // Defense: a zero exit with no URL is still a failure for our purposes
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            { cwd: '/x', token: { value: 't', origin: 'env' } },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stdout.emit('data', Buffer.from('Some unrelated stdout\n'));
        fakeChild.emit('close', 0);

        const result = await promise;
        expect(result.status).toBe('failure');
        expect(result.previewUrl).toBeUndefined();
    });

    it('returns failure when spawn emits an error', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            { cwd: '/x', token: { value: 't', origin: 'env' } },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.emit('error', new Error('ENOENT: vercel not found'));

        const result = await promise;
        expect(result.status).toBe('failure');
        expect(result.stderr).toContain('vercel not found');
        expect(result.exitCode).toBeNull();
    });

    it('passes --scope when input.scope is set', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            {
                cwd: '/x',
                token: { value: 't', origin: 'env' },
                scope: 'my-team',
            },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stdout.emit('data', Buffer.from('Preview: https://a-b.vercel.app\n'));
        fakeChild.emit('close', 0);

        await promise;
        const [, args] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args).toContain('--scope');
        expect(args).toContain('my-team');
    });

    it('omits --scope by default (operator personal scope per D-12)', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            { cwd: '/x', token: { value: 't', origin: 'env' } },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stdout.emit('data', Buffer.from('Preview: https://a-b.vercel.app\n'));
        fakeChild.emit('close', 0);

        await promise;
        const [, args] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args).not.toContain('--scope');
    });

    it('always passes --prebuilt (D-10) and --yes', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            { cwd: '/x', token: { value: 't', origin: 'env' } },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stdout.emit('data', Buffer.from('Preview: https://a-b.vercel.app\n'));
        fakeChild.emit('close', 0);

        await promise;
        const [, args] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args).toContain('--prebuilt');
        expect(args).toContain('--yes');
        // Never --prod (D-13)
        expect(args).not.toContain('--prod');
    });

    // ── runtimeEnv → --env flags (Pillar 2.2 PR-D) ────────────

    it('emits one --env KEY=VALUE pair per runtimeEnv entry', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            {
                cwd: '/x',
                token: { value: 't', origin: 'env' },
                runtimeEnv: {
                    DATABASE_URL: 'postgres://user:pass@host/db',
                    CLERK_SECRET_KEY: 'sk_test_abc',
                },
            },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stdout.emit('data', Buffer.from('Preview: https://a.vercel.app\n'));
        fakeChild.emit('close', 0);
        await promise;

        const [, args] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
        const envIndex = args.indexOf('--env');
        expect(envIndex).toBeGreaterThan(-1);

        const envPairs: string[] = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--env' && i + 1 < args.length) envPairs.push(args[i + 1]!);
        }
        // BPF-5: on Windows the KEY=VALUE token is double-quoted for the shell;
        // normalize so this assertion holds on both platforms.
        const unquote = (s: string): string => s.replace(/^"(.*)"$/, '$1');
        expect(envPairs.map(unquote)).toContain('DATABASE_URL=postgres://user:pass@host/db');
        expect(envPairs.map(unquote)).toContain('CLERK_SECRET_KEY=sk_test_abc');
    });

    it('omits --env entirely when runtimeEnv is undefined', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            { cwd: '/x', token: { value: 't', origin: 'env' } },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stdout.emit('data', Buffer.from('Preview: https://a.vercel.app\n'));
        fakeChild.emit('close', 0);
        await promise;

        const [, args] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args).not.toContain('--env');
    });

    it('omits --env when runtimeEnv is an empty object', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDeploy(
            { cwd: '/x', token: { value: 't', origin: 'env' }, runtimeEnv: {} },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stdout.emit('data', Buffer.from('Preview: https://a.vercel.app\n'));
        fakeChild.emit('close', 0);
        await promise;

        const [, args] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(args).not.toContain('--env');
    });

    it('throws synchronously when a runtimeEnv value contains a newline', async () => {
        const spawnFn: SpawnFn = vi.fn();
        await expect(
            runDeploy(
                {
                    cwd: '/x',
                    token: { value: 't', origin: 'env' },
                    runtimeEnv: { BAD: 'value\nwith\nnewline' },
                },
                spawnFn
            )
        ).rejects.toThrow(/newline/);
        expect((spawnFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });
});
