/**
 * Direct unit tests for the ai-adapter text utilities.
 *
 * Covers `stripThinkingTags` (reasoning-model <think>…</think> removal) and
 * `classifyHttpError` (status-code → error-class mapping). Both live in
 * `src/agents/ai-adapter/text-utils.ts` but were previously exercised only
 * transitively via provider tests.
 */

import { describe, it, expect } from 'vitest';

import {
    classifyHttpError,
    stripThinkingTags,
} from '../../../src/agents/ai-adapter/text-utils';

describe('stripThinkingTags', () => {
    it('removes a single <think>...</think> block', () => {
        const input = '<think>internal monologue</think>Actual answer';
        expect(stripThinkingTags(input)).toBe('Actual answer');
    });

    it('removes multiple <think> blocks in one pass', () => {
        const input = '<think>one</think>part one<think>two</think>part two';
        expect(stripThinkingTags(input)).toBe('part onepart two');
    });

    it('strips across multi-line reasoning blocks', () => {
        const input = '<think>\nline 1\nline 2\n</think>\nfinal output';
        expect(stripThinkingTags(input)).toBe('final output');
    });

    it('is case-insensitive on the tag name', () => {
        const input = '<THINK>noise</THINK>real';
        expect(stripThinkingTags(input)).toBe('real');
    });

    it('returns text unchanged when no tags are present', () => {
        expect(stripThinkingTags('plain reply')).toBe('plain reply');
    });

    it('trims surrounding whitespace after stripping', () => {
        const input = '  <think>noise</think>\n\n  answer  ';
        expect(stripThinkingTags(input)).toBe('answer');
    });

    it('returns empty string when the input is only a thinking block', () => {
        expect(stripThinkingTags('<think>only noise here</think>')).toBe('');
    });
});

describe('classifyHttpError', () => {
    it('maps 429 to rate-limit', () => {
        expect(classifyHttpError(429)).toBe('rate-limit');
    });

    it('maps 408 to timeout', () => {
        expect(classifyHttpError(408)).toBe('timeout');
    });

    it('maps 401 to auth-error', () => {
        expect(classifyHttpError(401)).toBe('auth-error');
    });

    it('maps 403 to auth-error', () => {
        expect(classifyHttpError(403)).toBe('auth-error');
    });

    it('maps 500 and above to server-error', () => {
        expect(classifyHttpError(500)).toBe('server-error');
        expect(classifyHttpError(503)).toBe('server-error');
        expect(classifyHttpError(599)).toBe('server-error');
    });

    it('defaults an unknown 4xx to client-error', () => {
        expect(classifyHttpError(400)).toBe('client-error');
        expect(classifyHttpError(418)).toBe('client-error');
    });

    it('upgrades a client-error to rate-limit when body mentions rate_limit', () => {
        expect(classifyHttpError(400, 'error: rate_limit exceeded')).toBe('rate-limit');
    });

    it('upgrades a client-error to rate-limit via "rate limit" text', () => {
        expect(classifyHttpError(400, 'Too many requests — rate limit hit')).toBe('rate-limit');
    });

    it('does not upgrade on body text when the status is already categorised', () => {
        // 429 is already rate-limit; body doesn't affect the outcome.
        expect(classifyHttpError(429, 'rate_limit')).toBe('rate-limit');
        // 401 stays auth-error even when body mentions rate-limit wording.
        expect(classifyHttpError(401, 'rate_limit')).toBe('auth-error');
    });
});
