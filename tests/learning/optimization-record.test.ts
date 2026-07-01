/**
 * Tests for src/learning/optimization-record.ts
 *
 * Covers:
 *   1. persistProposedOptimization inserts with all fields mapped and
 *      coerces numeric columns returned as strings
 *   2. persistProposedOptimization rejects non-APO-eligible agents
 *   3. markOptimizationAccepted updates + stamps applied_at
 *   4. markOptimizationAccepted returns null when row missing
 *   5. markOptimizationRolledBack flips status without clearing applied_at
 *   6. findLatestAcceptedForAgent selects the right row
 *   7. listPromptOptimizations builds filters + enforces limit bounds
 *   8. getPromptOptimization returns null for missing rows
 *   9. rowToRecord handles Date and string timestamps interchangeably
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock db/client (hoisted, per skill-store.test.ts pattern) ─

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const reset = (): void => {
        queryFn.mockClear();
        getOneFn.mockClear();
        getManyFn.mockClear();
    };
    return {
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        reset,
        module: () => ({
            query: queryFn,
            getOne: getOneFn,
            getMany: getManyFn,
            initDatabase: vi.fn(async () => undefined),
            testConnection: vi.fn(async () => true),
            closePool: vi.fn(async () => undefined),
            getPool: vi.fn(() => ({ query: queryFn, end: vi.fn() })),
        }),
    };
});

vi.mock('../../src/db/client', () => mockDb.module());

// Import AFTER the mock is registered.
import {
    findLatestAcceptedForAgent,
    getPromptOptimization,
    listPromptOptimizations,
    markOptimizationAccepted,
    markOptimizationRolledBack,
    persistProposedOptimization,
} from '../../src/learning/optimization-record';
import type { OptimizationResult } from '../../src/learning/types';

// ── Fixtures ─────────────────────────────────────────

function makeResult(overrides: Partial<OptimizationResult> = {}): OptimizationResult {
    return {
        agentName: 'scout',
        baselinePrompt: 'You are Scout.',
        baselineReward: 0.8,
        winner: 'You are Scout. Be concise.',
        winnerReward: 0.92,
        delta: 0.12,
        rounds: 3,
        beamWidth: 4,
        branchFactor: 3,
        history: [],
        ...overrides,
    };
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        agent_name: 'scout',
        baseline_prompt: 'You are Scout.',
        optimized_prompt: 'You are Scout. Be concise.',
        baseline_reward: '0.800000',
        optimized_reward: '0.920000',
        reward_delta: '0.120000',
        beam_width: 4,
        branch_factor: 3,
        rounds: 3,
        n_samples: 6,
        status: 'proposed',
        created_at: new Date('2026-04-21T01:02:03.000Z'),
        applied_at: null,
        ...overrides,
    };
}

beforeEach(() => {
    mockDb.reset();
});

// ── persistProposedOptimization ──────────────────────

describe('persistProposedOptimization', () => {
    it('inserts with OptimizationResult fields and returns a coerced record', async () => {
        mockDb.getOne.mockResolvedValueOnce(makeRow() as never);

        const record = await persistProposedOptimization(makeResult(), { nSamples: 6 });

        expect(record.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(record.agentName).toBe('scout');
        expect(record.baselineReward).toBeCloseTo(0.8, 6);
        expect(record.optimizedReward).toBeCloseTo(0.92, 6);
        expect(record.rewardDelta).toBeCloseTo(0.12, 6);
        expect(record.status).toBe('proposed');
        expect(record.createdAt).toBe('2026-04-21T01:02:03.000Z');
        expect(record.appliedAt).toBeNull();

        // SQL & param shape
        expect(mockDb.getOne).toHaveBeenCalledTimes(1);
        const call = mockDb.getOne.mock.calls[0];
        const sql = call?.[0] as string;
        const params = call?.[1] as unknown[];
        expect(sql).toMatch(/INSERT INTO prompt_optimizations/);
        expect(sql).toMatch(/'proposed'/);
        expect(params).toEqual([
            'scout',
            'You are Scout.',
            'You are Scout. Be concise.',
            0.8,
            0.92,
            0.12,
            4,
            3,
            3,
            6,
        ]);
    });

    it('rejects non-APO-eligible agents before touching the DB', async () => {
        await expect(
            persistProposedOptimization(makeResult({ agentName: 'sensei' }), { nSamples: 6 })
        ).rejects.toThrow(/not APO-eligible/);
        expect(mockDb.getOne).not.toHaveBeenCalled();
    });

    it('rejects negative nSamples', async () => {
        await expect(
            persistProposedOptimization(makeResult(), { nSamples: -1 })
        ).rejects.toThrow(/nSamples must be >= 0/);
    });

    it('throws when the INSERT returns no row (should never happen)', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        await expect(
            persistProposedOptimization(makeResult(), { nSamples: 6 })
        ).rejects.toThrow(/INSERT returned no row/);
    });
});

// ── markOptimizationAccepted ─────────────────────────

describe('markOptimizationAccepted', () => {
    it('updates status to accepted and stamps applied_at in ISO form', async () => {
        const ts = new Date('2026-04-21T02:30:00.000Z');
        mockDb.getOne.mockResolvedValueOnce(
            makeRow({ status: 'accepted', applied_at: ts }) as never
        );

        const record = await markOptimizationAccepted(
            'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            ts
        );

        expect(record?.status).toBe('accepted');
        expect(record?.appliedAt).toBe('2026-04-21T02:30:00.000Z');

        const call = mockDb.getOne.mock.calls[0];
        const sql = call?.[0] as string;
        const params = call?.[1] as unknown[];
        expect(sql).toMatch(/SET status = 'accepted', applied_at = \$2/);
        expect(params).toEqual([
            'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            '2026-04-21T02:30:00.000Z',
        ]);
    });

    it('returns null when the row does not exist', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        expect(await markOptimizationAccepted('missing-id')).toBeNull();
    });
});

// ── markOptimizationRolledBack ───────────────────────

describe('markOptimizationRolledBack', () => {
    it('flips status to rolled_back without clearing applied_at', async () => {
        mockDb.getOne.mockResolvedValueOnce(
            makeRow({
                status: 'rolled_back',
                applied_at: new Date('2026-04-21T02:30:00.000Z'),
            }) as never
        );

        const record = await markOptimizationRolledBack(
            'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        );

        expect(record?.status).toBe('rolled_back');
        expect(record?.appliedAt).toBe('2026-04-21T02:30:00.000Z');

        const sql = mockDb.getOne.mock.calls[0]?.[0] as string;
        expect(sql).toMatch(/SET status = 'rolled_back'/);
        expect(sql).not.toMatch(/applied_at =/);
    });

    it('returns null when the row does not exist', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        expect(await markOptimizationRolledBack('missing')).toBeNull();
    });
});

// ── findLatestAcceptedForAgent ───────────────────────

describe('findLatestAcceptedForAgent', () => {
    it('queries for the newest accepted row for the agent', async () => {
        mockDb.getOne.mockResolvedValueOnce(
            makeRow({ status: 'accepted', applied_at: new Date() }) as never
        );
        await findLatestAcceptedForAgent('scout');

        const call = mockDb.getOne.mock.calls[0];
        const sql = call?.[0] as string;
        const params = call?.[1] as unknown[];
        expect(sql).toMatch(/WHERE agent_name = \$1 AND status = 'accepted'/);
        expect(sql).toMatch(/ORDER BY applied_at DESC NULLS LAST, created_at DESC/);
        expect(sql).toMatch(/LIMIT 1/);
        expect(params).toEqual(['scout']);
    });

    it('returns null when no accepted row exists', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        expect(await findLatestAcceptedForAgent('scout')).toBeNull();
    });
});

// ── listPromptOptimizations ──────────────────────────

describe('listPromptOptimizations', () => {
    it('returns newest-first rows with the default limit', async () => {
        mockDb.getMany.mockResolvedValueOnce([
            makeRow(),
            makeRow({ id: 'bbb', created_at: new Date('2026-04-20T00:00:00Z') }),
        ] as never);

        const records = await listPromptOptimizations();
        expect(records).toHaveLength(2);

        const sql = mockDb.getMany.mock.calls[0]?.[0] as string;
        const params = mockDb.getMany.mock.calls[0]?.[1] as unknown[];
        expect(sql).toMatch(/ORDER BY created_at DESC/);
        expect(params).toEqual([100]);
    });

    it('applies agentName filter in WHERE clause', async () => {
        mockDb.getMany.mockResolvedValueOnce([] as never);
        await listPromptOptimizations({ agentName: 'herald' });

        const sql = mockDb.getMany.mock.calls[0]?.[0] as string;
        const params = mockDb.getMany.mock.calls[0]?.[1] as unknown[];
        expect(sql).toMatch(/WHERE agent_name = \$1/);
        expect(params).toEqual(['herald', 100]);
    });

    it('applies status filter in WHERE clause', async () => {
        mockDb.getMany.mockResolvedValueOnce([] as never);
        await listPromptOptimizations({ status: 'accepted' });

        const sql = mockDb.getMany.mock.calls[0]?.[0] as string;
        const params = mockDb.getMany.mock.calls[0]?.[1] as unknown[];
        expect(sql).toMatch(/WHERE status = \$1/);
        expect(params).toEqual(['accepted', 100]);
    });

    it('combines agent + status filters', async () => {
        mockDb.getMany.mockResolvedValueOnce([] as never);
        await listPromptOptimizations({ agentName: 'pixel', status: 'proposed', limit: 25 });

        const sql = mockDb.getMany.mock.calls[0]?.[0] as string;
        const params = mockDb.getMany.mock.calls[0]?.[1] as unknown[];
        expect(sql).toMatch(/agent_name = \$1 AND status = \$2/);
        expect(params).toEqual(['pixel', 'proposed', 25]);
    });

    it('clamps limits outside [1, 500]', async () => {
        mockDb.getMany.mockResolvedValueOnce([] as never);
        await listPromptOptimizations({ limit: 9999 });
        expect(mockDb.getMany.mock.calls[0]?.[1]).toEqual([500]);

        mockDb.getMany.mockResolvedValueOnce([] as never);
        await listPromptOptimizations({ limit: 0 });
        expect(mockDb.getMany.mock.calls[1]?.[1]).toEqual([1]);
    });
});

// ── getPromptOptimization ────────────────────────────

describe('getPromptOptimization', () => {
    it('returns the row when found', async () => {
        mockDb.getOne.mockResolvedValueOnce(makeRow() as never);
        const record = await getPromptOptimization(
            'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        );
        expect(record?.agentName).toBe('scout');
    });

    it('returns null when the row is missing', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        expect(await getPromptOptimization('missing')).toBeNull();
    });
});

// ── rowToRecord (exercised indirectly) ───────────────

describe('rowToRecord coercion', () => {
    it('handles numeric columns returned as strings (node-postgres)', async () => {
        mockDb.getOne.mockResolvedValueOnce(
            makeRow({
                baseline_reward: '0.200000',
                optimized_reward: '0.600000',
                reward_delta: '0.400000',
            }) as never
        );
        const record = await getPromptOptimization('x');
        expect(record?.baselineReward).toBeCloseTo(0.2);
        expect(record?.optimizedReward).toBeCloseTo(0.6);
        expect(record?.rewardDelta).toBeCloseTo(0.4);
    });

    it('handles numeric columns returned as numbers (PGlite)', async () => {
        mockDb.getOne.mockResolvedValueOnce(
            makeRow({ baseline_reward: 0.2, optimized_reward: 0.6, reward_delta: 0.4 }) as never
        );
        const record = await getPromptOptimization('x');
        expect(record?.baselineReward).toBeCloseTo(0.2);
    });

    it('normalizes string timestamps to ISO form', async () => {
        mockDb.getOne.mockResolvedValueOnce(
            makeRow({ created_at: '2026-04-21T01:02:03Z' }) as never
        );
        const record = await getPromptOptimization('x');
        expect(record?.createdAt).toBe('2026-04-21T01:02:03.000Z');
    });

    it('coerces an unknown status back to "proposed"', async () => {
        mockDb.getOne.mockResolvedValueOnce(
            makeRow({ status: 'weird-value' }) as never
        );
        const record = await getPromptOptimization('x');
        expect(record?.status).toBe('proposed');
    });
});
