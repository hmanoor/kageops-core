/**
 * BPF-7 — "run locally / no hosting" mode flag.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { isHostingDisabled, HOSTING_DISABLED_MESSAGE } from '../../src/shared/hosting-mode';

describe('isHostingDisabled()', () => {
    const original = process.env['KAGEOPS_NO_HOSTING'];
    afterEach(() => {
        if (original === undefined) delete process.env['KAGEOPS_NO_HOSTING'];
        else process.env['KAGEOPS_NO_HOSTING'] = original;
    });

    it('is false by default (unset) — hosting ON', () => {
        delete process.env['KAGEOPS_NO_HOSTING'];
        expect(isHostingDisabled()).toBe(false);
    });

    it('is true for "1" and "true"', () => {
        process.env['KAGEOPS_NO_HOSTING'] = '1';
        expect(isHostingDisabled()).toBe(true);
        process.env['KAGEOPS_NO_HOSTING'] = 'true';
        expect(isHostingDisabled()).toBe(true);
    });

    it('stays OFF for empty / other values', () => {
        process.env['KAGEOPS_NO_HOSTING'] = '';
        expect(isHostingDisabled()).toBe(false);
        process.env['KAGEOPS_NO_HOSTING'] = 'yes';
        expect(isHostingDisabled()).toBe(false);
        process.env['KAGEOPS_NO_HOSTING'] = 'false';
        expect(isHostingDisabled()).toBe(false);
    });

    it('exposes an operator-facing message mentioning SETUP.md', () => {
        expect(HOSTING_DISABLED_MESSAGE).toMatch(/SETUP\.md/);
    });
});
