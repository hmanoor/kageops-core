/**
 * PhaseGateManager × Refusal integration.
 *
 * These validate the claim that actually matters: a refusal CLOSES its intent,
 * so a repeat refusal of the same intent does not re-publish. That is the
 * BPF-28 loop — an escalation whose Approve verb could not satisfy it, which
 * re-raised ~70 times against an auto-approving harness.
 *
 * The refusal.ts unit tests prove the shape. These prove the behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const reset = (): void => { queryFn.mockClear(); getOneFn.mockClear(); getManyFn.mockClear(); };
    const module = () => ({
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        initDatabase: vi.fn(async () => undefined),
        testConnection: vi.fn(async () => true),
        closePool: vi.fn(async () => undefined),
        getPool: vi.fn(() => ({ query: queryFn, end: vi.fn() })),
    });
    return { query: queryFn, getOne: getOneFn, getMany: getManyFn, reset, module };
});

vi.mock('../../src/db/client', () => mockDb.module());

import { PhaseGateManager } from '../../src/orchestrator/phase-gates';
import { createRefusal, isRefusal, type Refusal } from '../../src/shared/refusal';

const PROJECT = {
    id: 'proj-001',
    phase: 'development',
    trust_level: 'medium',
    autonomous_after_design: false,
    status: 'active',
};

function buildRefusal(overrides: Partial<Parameters<typeof createRefusal>[0]> = {}): Refusal {
    return createRefusal({
        reason: 'acceptance-violations',
        projectId: 'proj-001',
        phase: 'development',
        attemptsMade: 3,
        details: [{
            check: 'missing-id',
            expected: '<... id="cta-download">',
            message: 'Spec requires <... id="cta-download"> but it was not found',
            severity: 'must',
        }],
        ...overrides,
    });
}

/** approval.required publishes seen by the mock bus. */
function approvalEvents(eventBus: ReturnType<typeof createMockEventBus>): unknown[] {
    return eventBus.publish.mock.calls.filter((c) => c[0] === 'approval.required');
}

describe('requestApproval() with a refusal', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
        mockDb.getOne.mockResolvedValue(PROJECT as never);
    });

    it('publishes the structured refusal in the event payload, not just prose', async () => {
        const manager = new PhaseGateManager(eventBus as never);
        const refusal = buildRefusal();

        await manager.requestApproval('proj-001', refusal.summary, refusal);

        const calls = approvalEvents(eventBus);
        expect(calls).toHaveLength(1);
        const payload = (calls[0] as unknown[])[1] as { data: Record<string, unknown> };
        // The whole point: consumers get objects, not English to re-parse.
        expect(isRefusal(payload.data['refusal'])).toBe(true);
        const published = payload.data['refusal'] as Refusal;
        expect(published.details[0]?.check).toBe('missing-id');
        expect(published.retryable).toBe(false);
        expect(published.humanActionRequired).toBe(true);
    });

    it('does NOT re-publish when the same intent refuses again (the BPF-28 loop)', async () => {
        const manager = new PhaseGateManager(eventBus as never);

        await manager.requestApproval('proj-001', 'first', buildRefusal({ attemptsMade: 3 }));
        await manager.requestApproval('proj-001', 'second', buildRefusal({ attemptsMade: 4 }));
        await manager.requestApproval('proj-001', 'third', buildRefusal({ attemptsMade: 5 }));

        // Three refusals of one intent → exactly one escalation.
        expect(approvalEvents(eventBus)).toHaveLength(1);
    });

    it('survives the pathological case: 70 repeats still yield one escalation', async () => {
        const manager = new PhaseGateManager(eventBus as never);
        for (let i = 0; i < 70; i++) {
            await manager.requestApproval('proj-001', 'again', buildRefusal({ attemptsMade: i }));
        }
        expect(approvalEvents(eventBus)).toHaveLength(1);
    });

    it('still publishes for a DIFFERENT intent on the same project', async () => {
        const manager = new PhaseGateManager(eventBus as never);

        await manager.requestApproval('proj-001', 'acceptance', buildRefusal());
        await manager.requestApproval('proj-001', 'build', buildRefusal({ reason: 'build-failed' }));

        // Different reason = different intent = a genuinely new thing to tell
        // the operator about.
        expect(approvalEvents(eventBus)).toHaveLength(2);
    });

    it('publishes again after the operator resolves the gate', async () => {
        const manager = new PhaseGateManager(eventBus as never);

        await manager.requestApproval('proj-001', 'first', buildRefusal());
        expect(approvalEvents(eventBus)).toHaveLength(1);

        // Operator acted — the intent is resolved, so a later genuine refusal
        // must reach them rather than being deduped against a stale entry.
        manager.clearRefusalsForProject('proj-001');
        await manager.requestApproval('proj-001', 'second', buildRefusal());

        expect(approvalEvents(eventBus)).toHaveLength(2);
    });

    it('exposes the open refusal for the UI to read', async () => {
        const manager = new PhaseGateManager(eventBus as never);
        expect(manager.getOpenRefusal('proj-001')).toBeUndefined();

        await manager.requestApproval('proj-001', 'r', buildRefusal());

        const open = manager.getOpenRefusal('proj-001');
        expect(open?.reason).toBe('acceptance-violations');
        expect(open?.details).toHaveLength(1);
    });

    it('keeps a plain phase gate working unchanged (no regression)', async () => {
        const manager = new PhaseGateManager(eventBus as never);

        await manager.requestApproval('proj-001');
        await manager.requestApproval('proj-001', 'some prose reason');

        const calls = approvalEvents(eventBus);
        expect(calls).toHaveLength(2);
        for (const c of calls) {
            const payload = (c as unknown[])[1] as { data: Record<string, unknown> };
            expect(payload.data['refusal']).toBeUndefined();
        }
    });

    it('does not leak dedupe state between projects', async () => {
        const manager = new PhaseGateManager(eventBus as never);

        await manager.requestApproval('proj-001', 'a', buildRefusal({ projectId: 'proj-001' }));
        await manager.requestApproval('proj-002', 'b', buildRefusal({ projectId: 'proj-002' }));

        expect(approvalEvents(eventBus)).toHaveLength(2);

        // Clearing one project must not clear the other.
        manager.clearRefusalsForProject('proj-001');
        expect(manager.getOpenRefusal('proj-001')).toBeUndefined();
        expect(manager.getOpenRefusal('proj-002')).toBeDefined();
    });

    it('marks the project awaiting-approval on the first refusal', async () => {
        const manager = new PhaseGateManager(eventBus as never);
        await manager.requestApproval('proj-001', 'r', buildRefusal());

        const statusWrites = mockDb.query.mock.calls.filter(
            (c) => typeof c[0] === 'string' && c[0].includes(`status = 'awaiting-approval'`)
        );
        expect(statusWrites.length).toBeGreaterThanOrEqual(1);
    });
});
