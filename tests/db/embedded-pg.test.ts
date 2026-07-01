/**
 * EmbeddedPG adapter — mode selection behavior.
 *
 * The real PGlite-backed tests live in `scripts/embedded-pg-integration-test.mjs`
 * (runs against a live in-memory PGlite); these unit tests only exercise the
 * mode-selection logic, which is the piece the rest of the app branches on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isEmbeddedMode } from '../../src/db/embedded-pg';

describe('db/embedded-pg — isEmbeddedMode()', () => {
    const originalDbUrl = process.env['DATABASE_URL'];
    const originalMode = process.env['KAGEOPS_DB_MODE'];

    beforeEach(() => {
        delete process.env['DATABASE_URL'];
        delete process.env['KAGEOPS_DB_MODE'];
    });

    afterEach(() => {
        if (originalDbUrl !== undefined) process.env['DATABASE_URL'] = originalDbUrl;
        if (originalMode !== undefined) process.env['KAGEOPS_DB_MODE'] = originalMode;
    });

    it('defaults to embedded when DATABASE_URL and KAGEOPS_DB_MODE are unset', () => {
        expect(isEmbeddedMode()).toBe(true);
    });

    it('prefers external when DATABASE_URL is set', () => {
        process.env['DATABASE_URL'] = 'postgres://user:pass@host:5432/db';
        expect(isEmbeddedMode()).toBe(false);
    });

    it('KAGEOPS_DB_MODE=embedded overrides DATABASE_URL', () => {
        process.env['DATABASE_URL'] = 'postgres://user:pass@host:5432/db';
        process.env['KAGEOPS_DB_MODE'] = 'embedded';
        expect(isEmbeddedMode()).toBe(true);
    });

    it('KAGEOPS_DB_MODE=external forces external even without DATABASE_URL', () => {
        process.env['KAGEOPS_DB_MODE'] = 'external';
        expect(isEmbeddedMode()).toBe(false);
    });

    it('treats a whitespace-only DATABASE_URL as unset (stays embedded)', () => {
        process.env['DATABASE_URL'] = '   ';
        expect(isEmbeddedMode()).toBe(true);
    });

    it('respects the databaseUrlOverride arg over DATABASE_URL', () => {
        process.env['DATABASE_URL'] = 'postgres://user:pass@host:5432/db';
        expect(isEmbeddedMode('')).toBe(true);
    });
});
