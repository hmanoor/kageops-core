/**
 * gateMode() kill-switch parsing (PR-2 "verification teeth").
 */

import { describe, it, expect } from 'vitest';
import { gateMode, GATE_ENV } from '../../src/orchestrator/gate-modes';

describe('gateMode()', () => {
    it('returns the default when the var is unset', () => {
        expect(gateMode('X', 'block', {})).toBe('block');
        expect(gateMode('X', 'off', {})).toBe('off');
        expect(gateMode('X', 'warn', {})).toBe('warn');
    });

    it('returns the default when the var is empty/whitespace', () => {
        expect(gateMode('X', 'block', { X: '   ' })).toBe('block');
    });

    it('parses block tokens', () => {
        for (const v of ['block', 'BLOCK', 'blocking', 'on', '1', 'true', 'yes']) {
            expect(gateMode('X', 'off', { X: v })).toBe('block');
        }
    });

    it('parses warn tokens', () => {
        for (const v of ['warn', 'WARN', 'warning', 'advisory']) {
            expect(gateMode('X', 'block', { X: v })).toBe('warn');
        }
    });

    it('parses off tokens', () => {
        for (const v of ['off', 'none', 'skip', 'disabled', '0', 'false', 'no']) {
            expect(gateMode('X', 'block', { X: v })).toBe('off');
        }
    });

    it('falls back to the default for an unrecognised value', () => {
        expect(gateMode('X', 'warn', { X: 'banana' })).toBe('warn');
    });

    it('exposes the canonical env var names', () => {
        expect(GATE_ENV.requiredInitiator).toBe('KAGEOPS_GATE_REQUIRED_INITIATOR');
        expect(GATE_ENV.moduleInit).toBe('KAGEOPS_GATE_MODULE_INIT');
        expect(GATE_ENV.migration).toBe('KAGEOPS_GATE_MIGRATION');
        expect(GATE_ENV.e2e).toBe('KAGEOPS_GATE_E2E');
    });
});
