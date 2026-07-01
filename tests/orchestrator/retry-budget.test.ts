/**
 * Retry-budget parser (PR-6) — env-configurable, validated, clamped budgets
 * for the build-fix / acceptance-fix / deploy-preview self-heal loops.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveRetryBudget,
    RETRY_ENV,
    MIN_RETRY_BUDGET,
    MAX_RETRY_BUDGET,
} from '../../src/orchestrator/retry-budget';

const VAR = 'KAGEOPS_MAX_BUILD_RETRIES';

describe('resolveRetryBudget()', () => {
    it('returns the default when the var is unset', () => {
        expect(resolveRetryBudget(VAR, 2, {})).toBe(2);
    });

    it('returns the default when the var is blank or whitespace', () => {
        expect(resolveRetryBudget(VAR, 2, { [VAR]: '' })).toBe(2);
        expect(resolveRetryBudget(VAR, 2, { [VAR]: '   ' })).toBe(2);
    });

    it('parses a valid integer', () => {
        expect(resolveRetryBudget(VAR, 2, { [VAR]: '4' })).toBe(4);
        expect(resolveRetryBudget(VAR, 2, { [VAR]: ' 3 ' })).toBe(3);
    });

    it('accepts 0 (no auto-retry — escalate on first failure)', () => {
        expect(resolveRetryBudget(VAR, 2, { [VAR]: '0' })).toBe(0);
    });

    it('clamps values above MAX_RETRY_BUDGET down to the ceiling', () => {
        expect(resolveRetryBudget(VAR, 2, { [VAR]: '50' })).toBe(MAX_RETRY_BUDGET);
        expect(resolveRetryBudget(VAR, 2, { [VAR]: String(MAX_RETRY_BUDGET + 1) })).toBe(MAX_RETRY_BUDGET);
    });

    it('clamps negative values up to the floor', () => {
        expect(resolveRetryBudget(VAR, 2, { [VAR]: '-5' })).toBe(MIN_RETRY_BUDGET);
    });

    it('falls back to the default on non-integer garbage (does not crash the run)', () => {
        expect(resolveRetryBudget(VAR, 2, { [VAR]: 'abc' })).toBe(2);
        expect(resolveRetryBudget(VAR, 2, { [VAR]: '2.5' })).toBe(2);
        expect(resolveRetryBudget(VAR, 2, { [VAR]: 'Infinity' })).toBe(2);
        expect(resolveRetryBudget(VAR, 2, { [VAR]: 'NaN' })).toBe(2);
    });

    it('honours the boundary values exactly', () => {
        expect(resolveRetryBudget(VAR, 2, { [VAR]: String(MIN_RETRY_BUDGET) })).toBe(MIN_RETRY_BUDGET);
        expect(resolveRetryBudget(VAR, 2, { [VAR]: String(MAX_RETRY_BUDGET) })).toBe(MAX_RETRY_BUDGET);
    });

    it('defaults env to process.env when not injected', () => {
        const prev = process.env[VAR];
        delete process.env[VAR];
        try {
            expect(resolveRetryBudget(VAR, 2)).toBe(2);
            process.env[VAR] = '5';
            expect(resolveRetryBudget(VAR, 2)).toBe(5);
        } finally {
            if (prev === undefined) delete process.env[VAR];
            else process.env[VAR] = prev;
        }
    });
});

describe('RETRY_ENV', () => {
    it('exposes the three canonical self-heal loop env var names', () => {
        expect(RETRY_ENV.build).toBe('KAGEOPS_MAX_BUILD_RETRIES');
        expect(RETRY_ENV.acceptance).toBe('KAGEOPS_MAX_ACCEPTANCE_RETRIES');
        expect(RETRY_ENV.deployPreview).toBe('KAGEOPS_MAX_DEPLOY_PREVIEW_RETRIES');
    });
});
