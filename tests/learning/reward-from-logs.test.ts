/**
 * Tests for src/learning/reward-from-logs.ts
 *
 * Reward-function edge cases, aggregation stats, and the SQL fetch
 * (with a mock pool — no live Postgres).
 */

import { describe, it, expect, vi } from 'vitest';

import {
    aggregateRewards,
    deriveReward,
    eventTypeToStatus,
    fetchAgentLogs,
} from '../../src/learning/reward-from-logs';
import type { PoolLike } from '../../src/learning/pool-shape';
import type { AgentLog, AgentLogStatus } from '../../src/learning/types';

// ── Fixtures ─────────────────────────────────────────

function makeLog(overrides: Partial<AgentLog> = {}): AgentLog {
    return Object.freeze({
        id: 'log-1',
        taskId: 'task-1',
        agentName: 'scout',
        costUsd: 0.01,
        tokensOut: 100,
        status: 'success',
        durationMs: 250,
        outputSummary: '',
        createdAt: '2026-04-21T00:00:00Z',
        ...overrides,
    });
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '11111111-1111-1111-1111-111111111111',
        task_id: '22222222-2222-2222-2222-222222222222',
        agent: 'scout',
        cost_usd: '0.010000',
        tokens_out: 100,
        event_type: 'task.completed',
        duration_ms: 250,
        output_summary: 'ok',
        created_at: '2026-04-21T00:00:00Z',
        ...overrides,
    };
}

// ── deriveReward ─────────────────────────────────────

describe('deriveReward()', () => {
    it('success + zero cost → 1.0', () => {
        expect(deriveReward(makeLog({ status: 'success', costUsd: 0 }))).toBe(1);
    });

    it('success + very small cost → slightly under 1', () => {
        const r = deriveReward(makeLog({ status: 'success', costUsd: 0.01 }));
        expect(r).toBeCloseTo(0.96, 6);
    });

    it('success + $0.05 → ~0.8', () => {
        const r = deriveReward(makeLog({ status: 'success', costUsd: 0.05 }));
        expect(r).toBeCloseTo(0.8, 6);
    });

    it('success at the cap → floors at 0.2', () => {
        expect(deriveReward(makeLog({ status: 'success', costUsd: 0.2 }))).toBeCloseTo(0.2, 6);
    });

    it('success above the cap → still 0.2 (saturates, never below floor)', () => {
        expect(deriveReward(makeLog({ status: 'success', costUsd: 5 }))).toBeCloseTo(0.2, 6);
    });

    it('success + negative cost is clamped to 0', () => {
        expect(deriveReward(makeLog({ status: 'success', costUsd: -1 }))).toBe(1);
    });

    it('escalated → -0.2', () => {
        expect(deriveReward(makeLog({ status: 'escalated', costUsd: 5 }))).toBe(-0.2);
    });

    it('failed → -0.5 regardless of cost', () => {
        expect(deriveReward(makeLog({ status: 'failed', costUsd: 0 }))).toBe(-0.5);
        expect(deriveReward(makeLog({ status: 'failed', costUsd: 999 }))).toBe(-0.5);
    });

    it('unknown → 0 (no signal)', () => {
        expect(deriveReward(makeLog({ status: 'unknown' }))).toBe(0);
    });

    it('result is always in [-1, 1]', () => {
        const statuses: readonly AgentLogStatus[] = ['success', 'failed', 'escalated', 'unknown'];
        for (const s of statuses) {
            for (const c of [0, 0.001, 0.1, 1, 100]) {
                const r = deriveReward(makeLog({ status: s, costUsd: c }));
                expect(r).toBeGreaterThanOrEqual(-1);
                expect(r).toBeLessThanOrEqual(1);
            }
        }
    });
});

// ── aggregateRewards ─────────────────────────────────

describe('aggregateRewards()', () => {
    it('empty batch → zero stats', () => {
        expect(aggregateRewards([])).toEqual({ mean: 0, n: 0, p50: 0 });
    });

    it('single-row batch → mean == p50 == that row', () => {
        const logs = [makeLog({ status: 'success', costUsd: 0 })];
        const agg = aggregateRewards(logs);
        expect(agg.n).toBe(1);
        expect(agg.mean).toBe(1);
        expect(agg.p50).toBe(1);
    });

    it('mixed batch — mean over all', () => {
        const logs = [
            makeLog({ status: 'success', costUsd: 0 }),     // +1.0
            makeLog({ status: 'success', costUsd: 0.05 }),  // +0.8
            makeLog({ status: 'failed' }),                  // -0.5
            makeLog({ status: 'escalated' }),               // -0.2
        ];
        const agg = aggregateRewards(logs);
        expect(agg.n).toBe(4);
        // (1 + 0.8 - 0.5 - 0.2) / 4 = 0.275
        expect(agg.mean).toBeCloseTo(0.275, 6);
    });

    it('p50 picks the upper median on even-sized batches', () => {
        // Sorted rewards: [-0.5, -0.2, 0.8, 1.0]; upper median → index 2 = 0.8
        const logs = [
            makeLog({ status: 'success', costUsd: 0 }),
            makeLog({ status: 'success', costUsd: 0.05 }),
            makeLog({ status: 'failed' }),
            makeLog({ status: 'escalated' }),
        ];
        expect(aggregateRewards(logs).p50).toBeCloseTo(0.8, 6);
    });

    it('p50 is the middle element on odd-sized batches', () => {
        const logs = [
            makeLog({ status: 'success', costUsd: 0 }),
            makeLog({ status: 'failed' }),
            makeLog({ status: 'escalated' }),
        ];
        // Sorted: [-0.5, -0.2, 1.0] → middle = -0.2
        expect(aggregateRewards(logs).p50).toBeCloseTo(-0.2, 6);
    });
});

// ── eventTypeToStatus ────────────────────────────────

describe('eventTypeToStatus()', () => {
    it('maps known event types', () => {
        expect(eventTypeToStatus('task.completed')).toBe('success');
        expect(eventTypeToStatus('task.failed')).toBe('failed');
        expect(eventTypeToStatus('approval.required')).toBe('escalated');
        expect(eventTypeToStatus('task.escalated')).toBe('escalated');
    });

    it('falls back to unknown for everything else', () => {
        expect(eventTypeToStatus('task.created')).toBe('unknown');
        expect(eventTypeToStatus('')).toBe('unknown');
        expect(eventTypeToStatus(null)).toBe('unknown');
        expect(eventTypeToStatus(undefined)).toBe('unknown');
    });
});

// ── fetchAgentLogs ───────────────────────────────────

describe('fetchAgentLogs()', () => {
    function makePool(rows: readonly Record<string, unknown>[]): PoolLike & { query: ReturnType<typeof vi.fn> } {
        const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
        return { query } as PoolLike & { query: ReturnType<typeof vi.fn> };
    }

    it('issues a parameterized query against agent_logs', async () => {
        const pool = makePool([makeRow()]);
        await fetchAgentLogs(pool, 'Scout', 25);

        expect(pool.query).toHaveBeenCalledOnce();
        const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('FROM agent_logs');
        expect(sql).toContain('ORDER BY created_at DESC');
        expect(sql).toContain('LIMIT $2');
        // agent name lower-cased; limit passed through
        expect(params[0]).toBe('scout');
        expect(params[1]).toBe(25);
    });

    it('filters to the four reward-bearing event types', async () => {
        const pool = makePool([]);
        await fetchAgentLogs(pool, 'scout');
        const [sql] = pool.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain("'task.completed'");
        expect(sql).toContain("'task.failed'");
        expect(sql).toContain("'approval.required'");
        expect(sql).toContain("'task.escalated'");
    });

    it('defaults limit to 50', async () => {
        const pool = makePool([]);
        await fetchAgentLogs(pool, 'scout');
        const [, params] = pool.query.mock.calls[0] as [string, unknown[]];
        expect(params[1]).toBe(50);
    });

    it('maps rows to AgentLog with normalized status', async () => {
        const pool = makePool([
            makeRow({ event_type: 'task.completed' }),
            makeRow({ id: 'log-2', event_type: 'task.failed', cost_usd: '0.05' }),
            makeRow({ id: 'log-3', event_type: 'approval.required' }),
        ]);

        const logs = await fetchAgentLogs(pool, 'scout');
        expect(logs).toHaveLength(3);
        expect(logs[0].status).toBe('success');
        expect(logs[1].status).toBe('failed');
        expect(logs[2].status).toBe('escalated');
        // numeric coercion
        expect(typeof logs[0].costUsd).toBe('number');
        expect(logs[1].costUsd).toBeCloseTo(0.05, 6);
        // result is frozen
        expect(Object.isFrozen(logs)).toBe(true);
        expect(Object.isFrozen(logs[0])).toBe(true);
    });

    it('handles null task_id and missing output_summary', async () => {
        const pool = makePool([
            makeRow({ task_id: null, output_summary: null }),
        ]);
        const logs = await fetchAgentLogs(pool, 'scout');
        expect(logs[0].taskId).toBeNull();
        expect(logs[0].outputSummary).toBe('');
    });

    it('coerces Date created_at to ISO string', async () => {
        const d = new Date('2026-01-01T12:00:00Z');
        const pool = makePool([makeRow({ created_at: d })]);
        const logs = await fetchAgentLogs(pool, 'scout');
        expect(logs[0].createdAt).toBe('2026-01-01T12:00:00.000Z');
    });

    it('returns an empty frozen array when no rows match', async () => {
        const pool = makePool([]);
        const logs = await fetchAgentLogs(pool, 'scout');
        expect(logs).toHaveLength(0);
        expect(Object.isFrozen(logs)).toBe(true);
    });
});
