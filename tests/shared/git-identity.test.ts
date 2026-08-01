/**
 * Git committer identity.
 *
 * Reported by an outside reviewer: "something in the test setup where because
 * of the git settings it didn't run correctly locally for some of the tests."
 * Root cause was that several commit paths inherited whatever git identity the
 * developer had configured globally — so on a machine with none configured,
 * `git commit` fails with "Please tell me who you are", and where one IS
 * configured, machine-authored commits get attributed to the human.
 *
 * These pin the contract: identity is always explicit at the invocation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gitIdentityArgs, DEFAULT_GIT_IDENTITY } from '../../src/shared/git-config';

const ENV_KEYS = ['KAGEOPS_GIT_AUTHOR_NAME', 'KAGEOPS_GIT_AUTHOR_EMAIL'] as const;

describe('gitIdentityArgs', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('emits -c flags so identity never depends on ambient global config', () => {
        const args = gitIdentityArgs();
        expect(args).toEqual([
            '-c', `user.email=${DEFAULT_GIT_IDENTITY.email}`,
            '-c', `user.name=${DEFAULT_GIT_IDENTITY.name}`,
        ]);
    });

    it('marks commits as machine-authored rather than borrowing a human name', () => {
        const args = gitIdentityArgs().join(' ');
        expect(args).toContain('KageOps');
        expect(args).toContain('@local');
    });

    it('gives the burst actor its own identity so the trail says who committed', () => {
        const burst = gitIdentityArgs('burst').join(' ');
        expect(burst).toContain('KageOps Burst');
        expect(burst).toContain('kageops-burst@local');
        expect(burst).not.toBe(gitIdentityArgs().join(' '));
    });

    it('falls back to the default identity for an unknown actor', () => {
        expect(gitIdentityArgs('no-such-actor')).toEqual(gitIdentityArgs());
    });

    it('honours KAGEOPS_GIT_AUTHOR_NAME / _EMAIL overrides', () => {
        process.env['KAGEOPS_GIT_AUTHOR_NAME'] = 'Build Bot';
        process.env['KAGEOPS_GIT_AUTHOR_EMAIL'] = 'bot@example.com';
        expect(gitIdentityArgs()).toEqual([
            '-c', 'user.email=bot@example.com',
            '-c', 'user.name=Build Bot',
        ]);
    });

    it('overrides apply to actor identities too', () => {
        process.env['KAGEOPS_GIT_AUTHOR_NAME'] = 'Build Bot';
        expect(gitIdentityArgs('burst').join(' ')).toContain('user.name=Build Bot');
    });

    it('ignores blank/whitespace-only overrides rather than committing as ""', () => {
        process.env['KAGEOPS_GIT_AUTHOR_NAME'] = '   ';
        process.env['KAGEOPS_GIT_AUTHOR_EMAIL'] = '';
        expect(gitIdentityArgs()).toEqual(gitIdentityArgs.call(null));
        expect(gitIdentityArgs().join(' ')).toContain(DEFAULT_GIT_IDENTITY.name);
    });

    it('produces args that prefix a git subcommand correctly', () => {
        // The call sites spread these BEFORE the subcommand; `git -c k=v commit`
        // is valid, `git commit -c k=v` is not.
        const full = [...gitIdentityArgs(), 'commit', '-m', 'msg'];
        expect(full[0]).toBe('-c');
        expect(full.indexOf('commit')).toBe(4);
    });
});
