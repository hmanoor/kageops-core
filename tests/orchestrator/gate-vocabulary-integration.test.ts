/**
 * End-to-end validation of the two gate enhancements.
 *
 * Enhancement 1 (Dry_Steak30): refusal is a terminal outcome — structured,
 * non-retryable, closing its intent, with terminal verbs instead of Approve.
 *
 * Enhancement 2 (KimLikeJ): a normal gate carries a falsifiable assumption
 * so the operator approves a claim rather than a phase name.
 *
 * These assert the two paths stay DISTINCT end to end — the failure being
 * defended against is precisely a refusal being dressed up as an ordinary
 * gate, which is how the ~70x re-raise loop happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => [] as unknown[]);
    return {
        query: queryFn, getOne: getOneFn, getMany: getManyFn,
        reset: (): void => { queryFn.mockClear(); getOneFn.mockClear(); getManyFn.mockClear(); },
        module: () => ({
            query: queryFn, getOne: getOneFn, getMany: getManyFn,
            initDatabase: vi.fn(async () => undefined),
            testConnection: vi.fn(async () => true),
            closePool: vi.fn(async () => undefined),
            getPool: vi.fn(() => ({ query: queryFn, end: vi.fn() })),
        }),
    };
});

vi.mock('../../src/db/client', () => mockDb.module());

import { PhaseGateManager } from '../../src/orchestrator/phase-gates';
import { createRefusal, isRefusal } from '../../src/shared/refusal';
import { parseAssumption, warrantsReview } from '../../src/shared/phase-assumption';

const PROJECT = {
    id: 'p1', phase: 'development', trust_level: 'medium',
    autonomous_after_design: false, status: 'active',
};

const refusal = createRefusal({
    reason: 'acceptance-violations',
    projectId: 'p1',
    phase: 'development',
    attemptsMade: 3,
    details: [{
        check: 'missing-id',
        expected: '<... id="cta-download">',
        message: 'Spec requires id="cta-download" but it was not found',
        severity: 'must',
    }],
    bestAttempt: { violations: 1, restored: true },
});

const assumption = parseAssumption([
    'CLAIM: The client wants a server-rendered site',
    'IF_WRONG: The routing and data-fetching layer is wasted work',
    'CONFIDENCE: low',
    'BASIS: inferred',
].join('\n'), 'design-planning')!;

function payloads(bus: ReturnType<typeof createMockEventBus>): Record<string, unknown>[] {
    return bus.publish.mock.calls
        .filter((c) => c[0] === 'approval.required')
        .map((c) => (c[1] as { data: Record<string, unknown> }).data);
}

describe('gate vocabulary — refusal vs normal gate', () => {
    let bus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        bus = createMockEventBus();
        mockDb.getOne.mockResolvedValue(PROJECT as never);
    });

    it('a refusal payload is terminal and carries its structure', async () => {
        const m = new PhaseGateManager(bus as never);
        await m.requestApproval('p1', refusal.summary, refusal);

        const [data] = payloads(bus);
        expect(isRefusal(data!['refusal'])).toBe(true);
        const r = data!['refusal'] as typeof refusal;
        expect(r.retryable).toBe(false);
        expect(r.humanActionRequired).toBe(true);
        expect(r.details[0]?.check).toBe('missing-id');
        // Names what would have to change — the anti-blind-retry field.
        expect(r.premiseForRetry.length).toBeGreaterThan(0);
        // Partial progress survives the refusal.
        expect(r.bestAttempt).toEqual({ violations: 1, restored: true });
    });

    it('a refusal message says it cannot complete, never "awaiting approval"', async () => {
        const m = new PhaseGateManager(bus as never);
        await m.requestApproval('p1', refusal.summary, refusal);

        const msg = String(payloads(bus)[0]!['message']);
        expect(msg).toContain('Cannot complete');
        expect(msg).toContain('human action required');
        expect(msg).not.toContain('Awaiting human approval');
    });

    it('a normal gate carries the assumption and no refusal', async () => {
        const m = new PhaseGateManager(bus as never);
        await m.requestApproval('p1', undefined, undefined, assumption);

        const [data] = payloads(bus);
        expect(data!['refusal']).toBeUndefined();
        expect(data!['assumption']).toBeDefined();
        const msg = String(data!['message']);
        expect(msg).toContain('Awaiting human approval');
        expect(msg).toContain('Assumes: The client wants a server-rendered site');
        expect(msg).toContain('if wrong, The routing and data-fetching layer is wasted work');
    });

    it('flags a low-confidence invented claim for review', async () => {
        const m = new PhaseGateManager(bus as never);
        await m.requestApproval('p1', undefined, undefined, assumption);

        expect(payloads(bus)[0]!['assumptionWarrantsReview']).toBe(true);
        expect(warrantsReview(assumption)).toBe(true);
    });

    it('does not flag a confident claim taken from the brief', async () => {
        const solid = parseAssumption([
            'CLAIM: Payments clear before dispatch',
            'IF_WRONG: The order pipeline is sequenced wrongly',
            'CONFIDENCE: high',
            'BASIS: brief',
        ].join('\n'), 'development')!;

        const m = new PhaseGateManager(bus as never);
        await m.requestApproval('p1', undefined, undefined, solid);

        expect(payloads(bus)[0]!['assumptionWarrantsReview']).toBe(false);
    });

    it('a plain gate with neither stays exactly as it was (no regression)', async () => {
        const m = new PhaseGateManager(bus as never);
        await m.requestApproval('p1');

        const [data] = payloads(bus);
        expect(data!['refusal']).toBeUndefined();
        expect(data!['assumption']).toBeUndefined();
        expect(String(data!['message'])).toContain('Awaiting human approval to proceed.');
    });

    it('the two enhancements compose without interfering', async () => {
        const m = new PhaseGateManager(bus as never);
        // A refusal never carries an assumption: the work is over, so what it
        // rested on is no longer the question in front of the operator.
        await m.requestApproval('p1', refusal.summary, refusal, assumption);

        const [data] = payloads(bus);
        expect(isRefusal(data!['refusal'])).toBe(true);
        // Refusal wording wins the message — "cannot complete" outranks a claim.
        expect(String(data!['message'])).toContain('Cannot complete');
    });

    it('the refusal still dedupes while an assumption gate does not', async () => {
        const m = new PhaseGateManager(bus as never);

        await m.requestApproval('p1', refusal.summary, refusal);
        await m.requestApproval('p1', refusal.summary, refusal);
        expect(payloads(bus)).toHaveLength(1);

        // Normal gates are not intents and must keep publishing.
        await m.requestApproval('p1', undefined, undefined, assumption);
        await m.requestApproval('p1', undefined, undefined, assumption);
        expect(payloads(bus)).toHaveLength(3);
    });
});
