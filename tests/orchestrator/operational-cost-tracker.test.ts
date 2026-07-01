/**
 * OperationalCostTracker tests
 *
 * Mocks all DB queries to test sync logic, aggregation, and deduplication.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── DB mock (hoisted to avoid reference-before-initialization) ────────────────

const dbMocks = vi.hoisted(() => ({
    mockQuery: vi.fn(),
    mockGetMany: vi.fn(),
    mockGetOne: vi.fn(),
}));

const { mockQuery, mockGetMany, mockGetOne } = dbMocks;

vi.mock('../../src/db/client', () => ({
    query: dbMocks.mockQuery,
    getMany: dbMocks.mockGetMany,
    getOne: dbMocks.mockGetOne,
}));

// ── Import under test ─────────────────────────────────

import {
    OperationalCostTracker,
    resetOperationalCostTrackerForTesting,
    getOperationalCostTracker,
} from '../../src/orchestrator/operational-cost-tracker';

// ── Helpers ───────────────────────────────────────────

function makeSpendRow(overrides: Partial<{
    request_id: string;
    startTime: Date;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    spend: number;
    custom_llm_provider: string | null;
    metadata: Record<string, unknown> | null;
}> = {}) {
    return {
        request_id: overrides.request_id ?? 'req-001',
        startTime: overrides.startTime ?? new Date('2026-04-08T10:00:00Z'),
        model: overrides.model ?? 'claude/claude-sonnet-4-20250514',
        prompt_tokens: overrides.prompt_tokens ?? 1000,
        completion_tokens: overrides.completion_tokens ?? 500,
        spend: overrides.spend ?? 0.003,
        custom_llm_provider: overrides.custom_llm_provider ?? 'claude',
        metadata: overrides.metadata ?? null,
    };
}

// ── Tests ─────────────────────────────────────────────

describe('OperationalCostTracker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetOperationalCostTrackerForTesting();
    });

    afterEach(() => {
        resetOperationalCostTrackerForTesting();
    });

    describe('syncFromLiteLLM()', () => {
        it('skips sync when LiteLLM_SpendLogs table does not exist', async () => {
            mockGetOne.mockResolvedValue({ exists: false });

            const tracker = new OperationalCostTracker();
            await tracker.syncFromLiteLLM();

            // Should not have queried LiteLLM_SpendLogs
            expect(mockGetMany).not.toHaveBeenCalled();
            expect(mockQuery).not.toHaveBeenCalled();
        });

        it('inserts new spend rows with ON CONFLICT DO NOTHING', async () => {
            // Table exists
            mockGetOne.mockResolvedValue({ exists: true });

            const rows = [
                makeSpendRow({ request_id: 'req-001', spend: 0.003 }),
                makeSpendRow({ request_id: 'req-002', spend: 0.005 }),
            ];
            mockGetMany.mockResolvedValue(rows);
            mockQuery.mockResolvedValue({ rowCount: 1 });

            const tracker = new OperationalCostTracker();
            await tracker.syncFromLiteLLM();

            expect(mockQuery).toHaveBeenCalledTimes(2);
            const sql = mockQuery.mock.calls[0][0] as string;
            expect(sql).toContain('ON CONFLICT (litellm_request_id) DO NOTHING');
        });

        it('extracts agent and project_id from metadata', async () => {
            mockGetOne.mockResolvedValue({ exists: true });

            const row = makeSpendRow({
                request_id: 'req-meta-001',
                metadata: {
                    agent: 'forge',
                    project_id: 'proj-abc-123',
                    cost_type: 'project',
                },
            });
            mockGetMany.mockResolvedValue([row]);
            mockQuery.mockResolvedValue({ rowCount: 1 });

            const tracker = new OperationalCostTracker();
            await tracker.syncFromLiteLLM();

            const params = mockQuery.mock.calls[0][1] as unknown[];
            expect(params[0]).toBe('forge');      // agent
            expect(params[1]).toBe('proj-abc-123'); // project_id
            expect(params[9]).toBe('project');    // cost_type
        });

        it('uses platform cost_type from metadata', async () => {
            mockGetOne.mockResolvedValue({ exists: true });

            const row = makeSpendRow({
                metadata: { agent: 'sensei', cost_type: 'platform' },
            });
            mockGetMany.mockResolvedValue([row]);
            mockQuery.mockResolvedValue({ rowCount: 1 });

            const tracker = new OperationalCostTracker();
            await tracker.syncFromLiteLLM();

            const params = mockQuery.mock.calls[0][1] as unknown[];
            expect(params[9]).toBe('platform');
        });

        it('defaults to project cost_type when not in metadata', async () => {
            mockGetOne.mockResolvedValue({ exists: true });
            mockGetMany.mockResolvedValue([makeSpendRow({ metadata: null })]);
            mockQuery.mockResolvedValue({ rowCount: 1 });

            const tracker = new OperationalCostTracker();
            await tracker.syncFromLiteLLM();

            const params = mockQuery.mock.calls[0][1] as unknown[];
            expect(params[9]).toBe('project');
        });

        it('handles empty LiteLLM_SpendLogs gracefully', async () => {
            mockGetOne.mockResolvedValue({ exists: true });
            mockGetMany.mockResolvedValue([]);

            const tracker = new OperationalCostTracker();
            await tracker.syncFromLiteLLM();

            expect(mockQuery).not.toHaveBeenCalled();
        });

        it('continues past individual row failures', async () => {
            mockGetOne.mockResolvedValue({ exists: true });
            const rows = [
                makeSpendRow({ request_id: 'req-ok' }),
                makeSpendRow({ request_id: 'req-fail' }),
            ];
            mockGetMany.mockResolvedValue(rows);

            // First succeeds, second fails
            mockQuery
                .mockResolvedValueOnce({ rowCount: 1 })
                .mockRejectedValueOnce(new Error('DB constraint error'));

            const tracker = new OperationalCostTracker();
            // Should not throw
            await expect(tracker.syncFromLiteLLM()).resolves.toBeUndefined();
        });
    });

    describe('recordDirectCost()', () => {
        it('inserts a direct cost entry with NULL litellm_request_id', async () => {
            mockQuery.mockResolvedValue({ rowCount: 1 });

            const tracker = new OperationalCostTracker();
            await tracker.recordDirectCost({
                agent: 'forge',
                projectId: 'proj-123',
                taskId: 'task-456',
                provider: 'claude',
                model: 'claude-cli',
                tokensIn: 200,
                tokensOut: 100,
                costUsd: 0,
                costType: 'project',
            });

            expect(mockQuery).toHaveBeenCalledTimes(1);
            const sql = mockQuery.mock.calls[0][0] as string;
            expect(sql).toContain('INSERT INTO operational_costs');
            expect(sql).toContain('NULL');

            const params = mockQuery.mock.calls[0][1] as unknown[];
            expect(params[0]).toBe('forge');
            expect(params[1]).toBe('proj-123');
            expect(params[2]).toBe('task-456');
            expect(params[3]).toBe('claude');
            expect(params[8]).toBe('project');
        });
    });

    describe('getOperationalSummary()', () => {
        it('returns empty summary when no data exists', async () => {
            // Mock all aggregation queries
            mockGetOne.mockResolvedValue({ total: '0' });
            mockGetMany.mockResolvedValue([]);

            const tracker = new OperationalCostTracker();
            const summary = await tracker.getOperationalSummary(30);

            expect(summary.totalToday).toBe(0);
            expect(summary.totalThisWeek).toBe(0);
            expect(summary.totalThisMonth).toBe(0);
            expect(summary.byAgent).toHaveLength(0);
            expect(summary.byProvider).toHaveLength(0);
            expect(summary.byProject).toHaveLength(0);
        });

        it('parses numeric strings from Postgres correctly', async () => {
            mockGetOne.mockResolvedValue({ total: '1.234567' });
            mockGetMany.mockResolvedValue([
                {
                    agent: 'forge',
                    total_cost: '0.84',
                    tokens_in: '10000',
                    tokens_out: '5000',
                    call_count: '12',
                },
            ]);

            const tracker = new OperationalCostTracker();
            const summary = await tracker.getOperationalSummary(7);

            expect(summary.totalToday).toBeCloseTo(1.234567);
            expect(summary.byAgent[0].agent).toBe('forge');
            expect(summary.byAgent[0].totalCostUsd).toBeCloseTo(0.84);
            expect(summary.byAgent[0].tokensIn).toBe(10000);
            expect(summary.byAgent[0].callCount).toBe(12);
        });

        it('sets lastSyncAt to null before first sync', async () => {
            mockGetOne.mockResolvedValue({ total: '0' });
            mockGetMany.mockResolvedValue([]);

            const tracker = new OperationalCostTracker();
            const summary = await tracker.getOperationalSummary();
            expect(summary.lastSyncAt).toBeNull();
        });
    });

    describe('start() / stop()', () => {
        it('starts interval and can be stopped', () => {
            const tracker = new OperationalCostTracker(5000);

            // Mock syncFromLiteLLM so it doesn't actually query DB
            vi.spyOn(tracker, 'syncFromLiteLLM').mockResolvedValue(undefined);

            tracker.start();
            tracker.stop();

            // After stop, no further calls should occur
            expect(tracker.syncFromLiteLLM).toHaveBeenCalled(); // initial call on start
        });
    });

    describe('getOperationalCostTracker() singleton', () => {
        it('returns the same instance on repeated calls', () => {
            resetOperationalCostTrackerForTesting();
            const a = getOperationalCostTracker();
            const b = getOperationalCostTracker();
            expect(a).toBe(b);
        });

        it('creates a fresh instance after reset', () => {
            const a = getOperationalCostTracker();
            resetOperationalCostTrackerForTesting();
            const b = getOperationalCostTracker();
            expect(a).not.toBe(b);
        });
    });
});
