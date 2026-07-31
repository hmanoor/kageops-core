/**
 * Refusal-as-first-class-outcome contract tests.
 *
 * The point of these is not coverage for its own sake — each one pins a
 * property that, when it broke, produced a real incident:
 *   - structure survived into the payload (it used to be flattened to prose)
 *   - the intent id is deterministic (this is what dedupes the re-raise loop)
 *   - nothing can construct a retryable refusal
 */
import { describe, it, expect } from 'vitest';
import {
    createRefusal,
    isRefusal,
    refusalIntentId,
    formatRefusalForPrompt,
    formatRefusalForHuman,
    type RefusalDetail,
} from '../../src/shared/refusal';

const DETAILS: readonly RefusalDetail[] = [
    {
        check: 'missing-id',
        expected: '<... id="cta-download">',
        message: 'Spec requires <... id="cta-download"> but it was not found in the artifact',
        severity: 'must',
    },
    {
        check: 'orphan-css-classes',
        expected: 'every HTML class has a matching CSS rule',
        message: '30 of 45 HTML classes have no matching CSS rule',
        severity: 'should',
    },
];

const base = {
    reason: 'acceptance-violations' as const,
    projectId: 'proj-1',
    phase: 'development',
    attemptsMade: 3,
    details: DETAILS,
};

describe('createRefusal', () => {
    it('preserves the structured details rather than flattening them to prose', () => {
        const r = createRefusal(base);
        expect(r.details).toHaveLength(2);
        expect(r.details[0]?.check).toBe('missing-id');
        expect(r.details[0]?.expected).toBe('<... id="cta-download">');
        expect(r.details[0]?.severity).toBe('must');
    });

    it('is terminal: retryable is false and human action is required', () => {
        const r = createRefusal(base);
        expect(r.retryable).toBe(false);
        expect(r.humanActionRequired).toBe(true);
        expect(r.status).toBe('refused');
    });

    it('derives a deterministic intent id from project + phase + reason', () => {
        const a = createRefusal(base);
        const b = createRefusal({ ...base, attemptsMade: 9, details: [] });
        // Same intent, different attempt count — still the SAME closed intent,
        // which is what lets the gate manager dedupe a re-raise.
        expect(a.intentId).toBe(b.intentId);
        expect(a.intentId).toBe(refusalIntentId('proj-1', 'development', 'acceptance-violations'));
    });

    it('gives different intents different ids', () => {
        const a = createRefusal(base);
        const b = createRefusal({ ...base, phase: 'launch-growth' });
        const c = createRefusal({ ...base, reason: 'build-failed' });
        expect(new Set([a.intentId, b.intentId, c.intentId]).size).toBe(3);
    });

    it('summarises using the blocking (must) violations, not the advisory ones', () => {
        const r = createRefusal(base);
        expect(r.summary).toContain('id="cta-download"');
        expect(r.summary).not.toContain('orphan-css-classes');
        expect(r.summary).toContain('3 remediation attempts');
    });

    it('singularises a single attempt', () => {
        const r = createRefusal({ ...base, attemptsMade: 1 });
        expect(r.summary).toContain('1 remediation attempt');
        expect(r.summary).not.toContain('attempts');
    });

    it('always states what premise must change for a new attempt', () => {
        for (const reason of ['acceptance-violations', 'build-failed', 'deploy-preview-failed'] as const) {
            const r = createRefusal({ ...base, reason });
            expect(r.premiseForRetry.length).toBeGreaterThan(0);
        }
    });

    it('carries the best attempt when one was restored', () => {
        const r = createRefusal({ ...base, bestAttempt: { violations: 1, restored: true } });
        expect(r.bestAttempt).toEqual({ violations: 1, restored: true });
    });

    it('omits bestAttempt entirely when none was restored', () => {
        expect(createRefusal(base).bestAttempt).toBeUndefined();
    });
});

describe('isRefusal', () => {
    it('accepts a real refusal round-tripped through JSON (the event-bus path)', () => {
        const r = createRefusal(base);
        expect(isRefusal(JSON.parse(JSON.stringify(r)))).toBe(true);
    });

    it('rejects a plain phase-gate payload', () => {
        expect(isRefusal({ currentPhase: 'development', message: 'blocked' })).toBe(false);
    });

    it('rejects anything claiming to be a retryable refusal', () => {
        expect(isRefusal({ status: 'refused', retryable: true, intentId: 'x', reason: 'y' })).toBe(false);
    });

    it('rejects null and non-objects', () => {
        expect(isRefusal(null)).toBe(false);
        expect(isRefusal('refused')).toBe(false);
        expect(isRefusal(undefined)).toBe(false);
    });
});

describe('formatRefusalForPrompt', () => {
    it('tells the model the intent is closed and not retryable', () => {
        const out = formatRefusalForPrompt(createRefusal(base));
        expect(out).toContain('REFUSED (terminal, not retryable)');
        expect(out).toContain('is closed after 3 attempt(s)');
    });

    it('keeps every violation as its own line with severity', () => {
        const out = formatRefusalForPrompt(createRefusal(base));
        expect(out).toContain('[must] missing-id');
        expect(out).toContain('[should] orphan-css-classes');
    });

    it('demands a changed premise instead of inviting a bare retry', () => {
        const out = formatRefusalForPrompt(createRefusal(base));
        expect(out).toContain('state what premise changed');
    });
});

describe('formatRefusalForHuman', () => {
    it('mentions the restored best attempt when there is one', () => {
        const r = createRefusal({ ...base, bestAttempt: { violations: 1, restored: true } });
        expect(formatRefusalForHuman(r)).toContain('restored to best attempt with 1 violation');
    });

    it('always says human action is required', () => {
        expect(formatRefusalForHuman(createRefusal(base))).toContain('human action required');
    });
});
