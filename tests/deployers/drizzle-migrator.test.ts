/**
 * P2.3-02 — drizzle-migrator unit tests.
 *
 * Locks in the FleetPulse smoke fix: Aegis must detect a Drizzle
 * migration step and run `drizzle-kit push` BEFORE invoking the
 * deployer. Without this the deployed `/dashboard` 500s on first SELECT.
 *
 * Covers:
 *   - detectMigrationIntent: db:push wins over sql files; missing dir → none
 *   - runDrizzlePush happy path + failure path with mocked spawn
 *   - DATABASE_URL hardening (empty + newline rejection)
 *   - DATABASE_URL is passed via env, not CLI args (never appears in argv)
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import {
    detectMigrationIntent,
    runDrizzlePush,
    type SpawnFn,
} from '../../src/deployers/drizzle-migrator';

// ── detectMigrationIntent ───────────────────────────────

describe('detectMigrationIntent()', () => {
    it('returns db-push-script when package.json declares db:push', async () => {
        const intent = await detectMigrationIntent('/fake/cwd', {
            readFile: async (p) => {
                expect(p.endsWith('package.json')).toBe(true);
                return JSON.stringify({ scripts: { 'db:push': 'drizzle-kit push' } });
            },
            readdir: async () => {
                throw new Error('should not be consulted when db:push wins');
            },
        });
        expect(intent).toEqual({ kind: 'db-push-script', script: 'drizzle-kit push' });
    });

    it('falls through to sql-files when package.json has no db:push', async () => {
        const intent = await detectMigrationIntent('/fake/cwd', {
            readFile: async () => JSON.stringify({ scripts: { build: 'next build' } }),
            readdir: async () => ['0001_create.sql', '0002_users.sql', 'README.md'],
        });
        expect(intent.kind).toBe('sql-files');
        if (intent.kind === 'sql-files') {
            expect(intent.count).toBe(2);
            expect(intent.directory.endsWith('drizzle')).toBe(true);
        }
    });

    it('returns none when neither package.json nor drizzle dir contributes', async () => {
        const intent = await detectMigrationIntent('/fake/cwd', {
            readFile: async () => {
                throw new Error('ENOENT');
            },
            readdir: async () => {
                throw new Error('ENOENT');
            },
        });
        expect(intent).toEqual({ kind: 'none' });
    });

    it('returns none when drizzle dir exists but has no .sql files', async () => {
        const intent = await detectMigrationIntent('/fake/cwd', {
            readFile: async () => {
                throw new Error('ENOENT');
            },
            readdir: async () => ['meta', 'README.md'],
        });
        expect(intent).toEqual({ kind: 'none' });
    });

    it('treats malformed package.json as missing (no throw)', async () => {
        const intent = await detectMigrationIntent('/fake/cwd', {
            readFile: async () => 'not valid json {',
            readdir: async () => ['0001.sql'],
        });
        expect(intent.kind).toBe('sql-files');
    });

    it('ignores non-string db:push entries', async () => {
        const intent = await detectMigrationIntent('/fake/cwd', {
            readFile: async () => JSON.stringify({ scripts: { 'db:push': 42 } }),
            readdir: async () => {
                throw new Error('ENOENT');
            },
        });
        expect(intent).toEqual({ kind: 'none' });
    });

    it('detects .SQL with mixed case extension', async () => {
        const intent = await detectMigrationIntent('/fake/cwd', {
            readFile: async () => {
                throw new Error('ENOENT');
            },
            readdir: async () => ['UPPERCASE.SQL'],
        });
        expect(intent.kind).toBe('sql-files');
    });
});

// ── runDrizzlePush ──────────────────────────────────────

interface FakeChild extends EventEmitter {
    stdout: EventEmitter;
    stderr: EventEmitter;
}

function makeFakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
}

describe('runDrizzlePush()', () => {
    it('reports pushed when exit code is 0', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDrizzlePush(
            { cwd: '/x', databaseUrl: 'postgres://u:p@host/db' },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stdout.emit('data', Buffer.from('No schema changes\n'));
        fakeChild.emit('close', 0);

        const result = await promise;
        expect(result.status).toBe('pushed');
        expect(result.exitCode).toBe(0);
    });

    it('reports failure when exit code is non-zero', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDrizzlePush(
            { cwd: '/x', databaseUrl: 'postgres://u:p@host/db' },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.stderr.emit('data', Buffer.from('connection refused'));
        fakeChild.emit('close', 1);

        const result = await promise;
        expect(result.status).toBe('failure');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('connection refused');
    });

    it('reports failure when spawn emits an error', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDrizzlePush(
            { cwd: '/x', databaseUrl: 'postgres://u:p@host/db' },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.emit('error', new Error('ENOENT: npx not found'));

        const result = await promise;
        expect(result.status).toBe('failure');
        expect(result.stderr).toContain('npx not found');
        expect(result.exitCode).toBeNull();
    });

    it('passes DATABASE_URL via env, never as a CLI arg', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const secret = 'postgres://leak:me@host/db?sslmode=require';
        const promise = runDrizzlePush(
            { cwd: '/x', databaseUrl: secret },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.emit('close', 0);
        await promise;

        const [cmd, args, opts] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
        expect(cmd === 'npx' || cmd === 'npx.cmd').toBe(true);
        // Closed-set args — drizzle CLI invocation only
        expect(args).toEqual(['--yes', 'drizzle-kit', 'push']);
        // DATABASE_URL never appears in argv (would show up in process listings)
        for (const arg of args as readonly string[]) {
            expect(arg).not.toContain('leak:me');
        }
        // Env is the carrier — and not inherited blindly
        const env = (opts as { env?: Record<string, string> }).env;
        expect(env?.['DATABASE_URL']).toBe(secret);
    });

    it('forwards extraEnv but DATABASE_URL wins on conflict', async () => {
        const fakeChild = makeFakeChild();
        const spawnFn: SpawnFn = vi.fn(() => fakeChild as never);

        const promise = runDrizzlePush(
            {
                cwd: '/x',
                databaseUrl: 'postgres://canonical/db',
                extraEnv: {
                    DATABASE_URL: 'postgres://overridden/db',
                    EXTRA_FLAG: '1',
                },
            },
            spawnFn
        );

        await Promise.resolve();
        fakeChild.emit('close', 0);
        await promise;

        const [, , opts] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0]!;
        const env = (opts as { env?: Record<string, string> }).env;
        expect(env?.['DATABASE_URL']).toBe('postgres://canonical/db');
        expect(env?.['EXTRA_FLAG']).toBe('1');
    });

    it('throws synchronously when DATABASE_URL is empty', async () => {
        const spawnFn: SpawnFn = vi.fn();
        await expect(
            runDrizzlePush({ cwd: '/x', databaseUrl: '' }, spawnFn)
        ).rejects.toThrow(/empty/);
        expect((spawnFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });

    it('throws synchronously when DATABASE_URL contains a newline', async () => {
        const spawnFn: SpawnFn = vi.fn();
        await expect(
            runDrizzlePush(
                { cwd: '/x', databaseUrl: 'postgres://u@host\nrm -rf /' },
                spawnFn
            )
        ).rejects.toThrow(/newline/);
        expect((spawnFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    });
});
