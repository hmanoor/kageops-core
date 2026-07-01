/**
 * BPF-35 — file-based app-env source for headless self-deploy.
 */

import { describe, it, expect } from 'vitest';
import { appEnvFilePath, loadAppEnvFile } from '../../src/orchestrator/app-env-file';

/** Build an injected readFileSync that returns `content` for any path. */
const reader = (content: string) => ((): string => content) as Parameters<typeof loadAppEnvFile>[1];
const throwing = ((): string => { throw new Error('ENOENT'); }) as Parameters<typeof loadAppEnvFile>[1];

describe('appEnvFilePath', () => {
    it('returns the path when KAGEOPS_APP_ENV_FILE is set', () => {
        expect(appEnvFilePath({ KAGEOPS_APP_ENV_FILE: 'C:/tmp/app.env' } as never)).toBe('C:/tmp/app.env');
    });
    it('returns null when unset or blank', () => {
        expect(appEnvFilePath({} as never)).toBeNull();
        expect(appEnvFilePath({ KAGEOPS_APP_ENV_FILE: '   ' } as never)).toBeNull();
    });
});

describe('loadAppEnvFile', () => {
    it('parses KEY=VALUE, export prefixes, comments and blank lines', () => {
        const content = [
            '# app env for ClubHub',
            '',
            'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_abc',
            'export CLERK_SECRET_KEY=sk_test_xyz',
            'STRIPE_SECRET_KEY = sk_test_stripe',
        ].join('\n');
        const out = loadAppEnvFile('app.env', reader(content));
        expect(out).toEqual({
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_abc',
            CLERK_SECRET_KEY: 'sk_test_xyz',
            STRIPE_SECRET_KEY: 'sk_test_stripe',
        });
    });

    it('preserves a quoted Neon URL with & and ? intact (the BPF-5 hazard)', () => {
        const url = 'postgresql://u:p@ep-x.aws.neon.tech/db?sslmode=require&channel_binding=require';
        const out = loadAppEnvFile('app.env', reader(`DATABASE_URL="${url}"`));
        expect(out).not.toBeNull();
        expect(out!.DATABASE_URL).toBe(url);
    });

    it('strips single quotes too', () => {
        const out = loadAppEnvFile('app.env', reader("FOO='bar baz'"));
        expect(out!.FOO).toBe('bar baz');
    });

    it('ignores malformed keys and lines without =', () => {
        const out = loadAppEnvFile('app.env', reader('1BAD=x\njust some prose\nGOOD=y'));
        expect(out).toEqual({ GOOD: 'y' });
    });

    it('returns null for an unreadable file (falls back to deployment_config)', () => {
        expect(loadAppEnvFile('missing.env', throwing)).toBeNull();
    });

    it('returns null when the file has no usable keys', () => {
        expect(loadAppEnvFile('app.env', reader('# only comments\n\n'))).toBeNull();
    });
});
