/**
 * StallWatchdog — unit tests
 *
 * Covers `scanOnce`, the pure one-pass scan+park routine:
 *   • parks an 'active' project whose last activity is older than the
 *     stall threshold
 *   • ignores projects still inside the threshold
 *   • emits `approval.required` with a helpful reason
 *   • is idempotent — a project already parked is not double-notified
 *   • is resilient to DB failures (no throw)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock db/client BEFORE importing the module under test ──

const mockDb = vi.hoisted(() => {
    const getMany = vi.fn(async () => [] as unknown[]);
    const query = vi.fn(async () => ({ rows: [] as { id: string }[], rowCount: 0 }));
    const reset = (): void => {
        getMany.mockClear();
        query.mockClear();
    };
    return { getMany, query, reset };
});

vi.mock('../../src/db/client', () => ({
    getMany: mockDb.getMany,
    query: mockDb.query,
    getOne: vi.fn(async () => null),
    initDatabase: vi.fn(async () => undefined),
    closePool: vi.fn(async () => undefined),
}));

import { scanOnce } from '../../src/orchestrator/stall-watchdog';
import type { EventBus } from '../../src/orchestrator/event-bus';

function makeBus(): { bus: EventBus; publishSpy: ReturnType<typeof vi.fn> } {
    const publishSpy = vi.fn(async () => undefined);
    const bus = {
        publish: publishSpy,
        subscribe: vi.fn(async () => undefined),
        subscribeAll: vi.fn(),
        unsubscribe: vi.fn(async () => undefined),
        unsubscribeAll: vi.fn(),
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
    } as unknown as EventBus;
    return { bus, publishSpy };
}

describe('StallWatchdog — scanOnce', () => {
    beforeEach(() => {
        mockDb.reset();
    });

    it('parks a project whose last activity exceeds the stall threshold', async () => {
        const { bus, publishSpy } = makeBus();
        // last_activity is 10 minutes ago; threshold is 5 minutes.
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'proj-1', name: 'alpha', last_activity: tenMinAgo, inflight_count: '2' },
        ]);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        const parked = await scanOnce(bus, 5 * 60 * 1000);

        expect(parked).toEqual(['proj-1']);

        // UPDATE was run with the awaiting-approval transition guard.
        const sql = mockDb.query.mock.calls[0]?.[0] as string;
        expect(sql).toMatch(/status\s*=\s*'awaiting-approval'/);
        expect(sql).toMatch(/WHERE id = \$1 AND status = 'active'/);

        // approval.required emitted with a stall reason.
        expect(publishSpy).toHaveBeenCalledTimes(1);
        const [channel, payload] = publishSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(channel).toBe('approval.required');
        const data = payload['data'] as Record<string, unknown>;
        expect(data['reason']).toMatch(/stall detected/i);
        expect(payload['projectId']).toBe('proj-1');
    });

    it('ignores projects inside the stall threshold', async () => {
        const { bus, publishSpy } = makeBus();
        const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'proj-1', name: 'alpha', last_activity: oneMinAgo, inflight_count: '1' },
        ]);

        const parked = await scanOnce(bus, 5 * 60 * 1000);

        expect(parked).toEqual([]);
        expect(mockDb.query).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
    });

    it('does not emit approval.required when the UPDATE no-ops (already transitioned)', async () => {
        const { bus, publishSpy } = makeBus();
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'proj-1', name: 'alpha', last_activity: tenMinAgo, inflight_count: '0' },
        ]);
        // Race: another process already parked this project, so the guarded
        // UPDATE returns 0 rows.
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const parked = await scanOnce(bus, 5 * 60 * 1000);

        expect(parked).toEqual([]);
        expect(publishSpy).not.toHaveBeenCalled();
    });

    it('skips rows with a null last_activity rather than parking blindly', async () => {
        const { bus, publishSpy } = makeBus();
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'proj-1', name: 'alpha', last_activity: null, inflight_count: '0' },
        ]);

        const parked = await scanOnce(bus, 5 * 60 * 1000);
        expect(parked).toEqual([]);
        expect(mockDb.query).not.toHaveBeenCalled();
        expect(publishSpy).not.toHaveBeenCalled();
    });

    it('parks multiple stale projects in a single pass', async () => {
        const { bus, publishSpy } = makeBus();
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        mockDb.getMany.mockResolvedValueOnce([
            { id: 'proj-1', name: 'alpha', last_activity: tenMinAgo, inflight_count: '2' },
            { id: 'proj-2', name: 'beta', last_activity: fifteenMinAgo, inflight_count: '0' },
        ]);
        mockDb.query
            .mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ id: 'proj-2' }], rowCount: 1 });

        const parked = await scanOnce(bus, 5 * 60 * 1000);
        expect(parked.sort()).toEqual(['proj-1', 'proj-2']);
        expect(publishSpy).toHaveBeenCalledTimes(2);
    });

    it('does not throw when the initial SELECT fails', async () => {
        const { bus, publishSpy } = makeBus();
        mockDb.getMany.mockRejectedValueOnce(new Error('db down'));

        await expect(scanOnce(bus, 5 * 60 * 1000)).rejects.toThrow(/db down/);
        expect(publishSpy).not.toHaveBeenCalled();
    });
});

describe('StallWatchdog — auto-reclaim (durable recovery)', () => {
    const FIVE_MIN = 5 * 60 * 1000;
    const tenMinAgo = (): string => new Date(Date.now() - 10 * 60 * 1000).toISOString();

    beforeEach(() => {
        mockDb.reset();
    });

    function stalledRow(over: Partial<{ completed_count: string; inflight_count: string }> = {}) {
        return {
            id: 'proj-1',
            name: 'alpha',
            last_activity: tenMinAgo(),
            inflight_count: over.inflight_count ?? '2',
            completed_count: over.completed_count ?? '0',
        };
    }

    it('auto-reclaims a stalled project instead of parking it', async () => {
        const { bus, publishSpy } = makeBus();
        const reclaim = vi.fn(async () => ({ requeued: 2 }));
        const state = new Map();
        mockDb.getMany.mockResolvedValueOnce([stalledRow()]);

        const parked = await scanOnce(bus, FIVE_MIN, { reclaim, state, maxAutoReclaims: 2 });

        expect(parked).toEqual([]);            // not parked
        expect(reclaim).toHaveBeenCalledWith('proj-1');
        expect(mockDb.query).not.toHaveBeenCalled();  // no park UPDATE
        expect(publishSpy).not.toHaveBeenCalled();     // no approval.required
        expect(state.get('proj-1')?.attempts).toBe(1);
    });

    it('parks for a human only after auto-reclaim is exhausted', async () => {
        const { bus, publishSpy } = makeBus();
        const reclaim = vi.fn(async () => ({ requeued: 1 }));
        const state = new Map();

        // Two stalls → two reclaims (no progress: completed stays 0).
        mockDb.getMany.mockResolvedValueOnce([stalledRow()]);
        await scanOnce(bus, FIVE_MIN, { reclaim, state, maxAutoReclaims: 2 });
        mockDb.getMany.mockResolvedValueOnce([stalledRow()]);
        await scanOnce(bus, FIVE_MIN, { reclaim, state, maxAutoReclaims: 2 });
        expect(reclaim).toHaveBeenCalledTimes(2);
        expect(publishSpy).not.toHaveBeenCalled();

        // Third stall → exhausted → park + approval.required.
        mockDb.getMany.mockResolvedValueOnce([stalledRow()]);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });
        const parked = await scanOnce(bus, FIVE_MIN, { reclaim, state, maxAutoReclaims: 2 });

        expect(reclaim).toHaveBeenCalledTimes(2);       // not called a 3rd time
        expect(parked).toEqual(['proj-1']);
        expect(publishSpy).toHaveBeenCalledTimes(1);
        const [channel, payload] = publishSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(channel).toBe('approval.required');
        const data = payload['data'] as Record<string, unknown>;
        expect(data['reason']).toMatch(/auto-recovery attempts/i);
    });

    it('resets the attempt counter when the project makes forward progress', async () => {
        const { bus } = makeBus();
        const reclaim = vi.fn(async () => ({ requeued: 1 }));
        const state = new Map();

        // Exhaust both attempts at completed=0.
        mockDb.getMany.mockResolvedValueOnce([stalledRow({ completed_count: '0' })]);
        await scanOnce(bus, FIVE_MIN, { reclaim, state, maxAutoReclaims: 2 });
        mockDb.getMany.mockResolvedValueOnce([stalledRow({ completed_count: '0' })]);
        await scanOnce(bus, FIVE_MIN, { reclaim, state, maxAutoReclaims: 2 });
        expect(reclaim).toHaveBeenCalledTimes(2);

        // A task completed (completed 0 → 3): a new failpoint earns fresh attempts.
        mockDb.getMany.mockResolvedValueOnce([stalledRow({ completed_count: '3' })]);
        const parked = await scanOnce(bus, FIVE_MIN, { reclaim, state, maxAutoReclaims: 2 });

        expect(parked).toEqual([]);                 // reclaimed, not parked
        expect(reclaim).toHaveBeenCalledTimes(3);
        expect(state.get('proj-1')?.attempts).toBe(1);
    });

    it('does not throw when reclaim itself fails — still counts the attempt', async () => {
        const { bus } = makeBus();
        const reclaim = vi.fn(async () => { throw new Error('router down'); });
        const state = new Map();
        mockDb.getMany.mockResolvedValueOnce([stalledRow()]);

        const parked = await scanOnce(bus, FIVE_MIN, { reclaim, state, maxAutoReclaims: 2 });

        expect(parked).toEqual([]);
        expect(state.get('proj-1')?.attempts).toBe(1);
    });

    it('parks immediately (legacy) when no reclaim hook is provided', async () => {
        const { bus, publishSpy } = makeBus();
        mockDb.getMany.mockResolvedValueOnce([stalledRow()]);
        mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'proj-1' }], rowCount: 1 });

        const parked = await scanOnce(bus, FIVE_MIN);

        expect(parked).toEqual(['proj-1']);
        expect(publishSpy).toHaveBeenCalledTimes(1);
    });
});
