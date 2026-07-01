/**
 * Direct unit tests for `calculateCost` and `estimateTokens`.
 *
 * These utilities are exercised transitively by the provider tests in
 * `tests/agents/ai-adapter.test.ts`, but the default-rate fallback branch
 * and the rounding behaviour of the token estimator were not directly
 * asserted anywhere.
 */

import { describe, it, expect } from 'vitest';

import { calculateCost, estimateTokens, PRICE_TABLE_REFRESHED_AT } from '../../../src/agents/ai-adapter/cost';

describe('calculateCost', () => {
    it('uses the known Claude Sonnet 4 rates ($3/$15 per M tokens)', () => {
        // 1M input @ $3 + 0.5M output @ $15 = $3 + $7.5 = $10.5
        const cost = calculateCost('claude-sonnet-4-20250514', 1_000_000, 500_000);
        expect(cost).toBeCloseTo(10.5, 6);
    });

    it('uses the known Opus 4 rates ($15/$75 per M tokens)', () => {
        // 1M input @ $15 + 1M output @ $75 = $90
        const cost = calculateCost('claude-opus-4-20250514', 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(90, 6);
    });

    it('uses the Haiku 3.5 rates ($0.80/$4.00 per M tokens)', () => {
        // 100k input @ $0.80 + 100k output @ $4.00 = $0.08 + $0.40 = $0.48
        const cost = calculateCost('claude-haiku-3-5-20241022', 100_000, 100_000);
        expect(cost).toBeCloseTo(0.48, 6);
    });

    // F-363: claude-cli and codex-cli no longer report $0 — synthetic
    // pricing mirrors the underlying API rate so budget-kill + dashboards
    // see a real spend signal. The CLI doesn't actually meter per-call
    // (subscription) but a real number is operationally comparable.
    it('synthesizes Sonnet-rate cost for claude-cli (F-363)', () => {
        // claude-cli rates: $3/$15 per M, same as Sonnet 4
        // 1M input + 1M output = $3 + $15 = $18
        expect(calculateCost('claude-cli', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    });

    it('synthesizes o4-equivalent cost for codex-cli (F-363)', () => {
        // codex-cli rates: $3/$12 per M
        // 1M input + 1M output = $3 + $12 = $15
        expect(calculateCost('codex-cli', 1_000_000, 1_000_000)).toBeCloseTo(15, 6);
    });

    it('routes claude-cli/<model> via fuzzy match to the right Sonnet variant', () => {
        // claude-cli/claude-sonnet-4-6 fuzzy-matches `claude-sonnet-4`
        // (substring) → $3/$15
        const cost = calculateCost('claude-cli/claude-sonnet-4-6', 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(18, 6);
    });

    it('falls back to the default rate table for unknown models', () => {
        // default rates: $1/$3 per M tokens
        // 1M input + 1M output = $1 + $3 = $4
        const cost = calculateCost('never-heard-of-this-model', 1_000_000, 1_000_000);
        expect(cost).toBeCloseTo(4, 6);
    });

    it('returns 0 when token counts are zero', () => {
        expect(calculateCost('claude-sonnet-4-20250514', 0, 0)).toBe(0);
    });
});

describe('PRICE_TABLE_REFRESHED_AT (F-369)', () => {
    it('exports an ISO-format date string', () => {
        expect(PRICE_TABLE_REFRESHED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe('estimateTokens', () => {
    it('rounds up to the nearest token (~4 chars/token)', () => {
        // 4 characters → exactly 1 token
        expect(estimateTokens('abcd')).toBe(1);
        // 5 characters → 2 tokens (ceil(5/4) = 2)
        expect(estimateTokens('abcde')).toBe(2);
    });

    it('returns 0 for the empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('scales roughly with input length (~char-count/4)', () => {
        const text = 'hello world'.repeat(100); // 1100 chars → ceil(1100/4) = 275
        expect(estimateTokens(text)).toBe(Math.ceil(text.length / 4));
    });
});
