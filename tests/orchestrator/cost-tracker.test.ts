/**
 * CostTracker unit tests
 *
 * Tests budget checking, cost recording, threshold events,
 * unlimited budgets, and budget enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── Mock setup ───────────────────────────────────────────────────────────────

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const initDatabaseFn = vi.fn(async () => undefined);
    const testConnectionFn = vi.fn(async () => true);
    const closePoolFn = vi.fn(async () => undefined);
    const getPoolFn = vi.fn(() => ({ query: queryFn, end: vi.fn() }));
    const reset = (): void => {
        queryFn.mockClear();
        getOneFn.mockClear();
        getManyFn.mockClear();
        initDatabaseFn.mockClear();
        testConnectionFn.mockClear();
        closePoolFn.mockClear();
        getPoolFn.mockClear();
    };
    return {
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        initDatabase: initDatabaseFn,
        testConnection: testConnectionFn,
        closePool: closePoolFn,
        getPool: getPoolFn,
        reset,
        module: () => ({
            query: queryFn,
            getOne: getOneFn,
            getMany: getManyFn,
            initDatabase: initDatabaseFn,
            testConnection: testConnectionFn,
            closePool: closePoolFn,
            getPool: getPoolFn,
        }),
    };
});

vi.mock('../../src/db/client', () => mockDb.module());

// Import after mocks
import { CostTracker, BudgetExceededError } from '../../src/orchestrator/cost-tracker';
import type { EventBus } from '../../src/orchestrator/event-bus';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CostTracker', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let tracker: CostTracker;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
        tracker = new CostTracker(eventBus as unknown as EventBus);
    });

    // ── getProjectSpent ─────────────────────────────────────────────────────

    describe('getProjectSpent()', () => {
        it('returns sum of cost_usd from agent_logs', async () => {
            mockDb.getOne.mockResolvedValueOnce({ total: '1.234567' });

            const spent = await tracker.getProjectSpent('proj-1');

            expect(spent).toBeCloseTo(1.234567, 6);
        });

        it('returns 0 when no logs exist', async () => {
            mockDb.getOne.mockResolvedValueOnce({ total: '0' });

            const spent = await tracker.getProjectSpent('proj-1');

            expect(spent).toBe(0);
        });

        it('returns 0 when result is null', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const spent = await tracker.getProjectSpent('proj-1');

            expect(spent).toBe(0);
        });
    });

    // ── getProjectBudget ────────────────────────────────────────────────────

    describe('getProjectBudget()', () => {
        it('returns budget status with remaining amount', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '25.50' });

            const status = await tracker.getProjectBudget('proj-1');

            expect(status.budgetUsd).toBe(100);
            expect(status.spentUsd).toBeCloseTo(25.5);
            expect(status.remainingUsd).toBeCloseTo(74.5);
            expect(status.exceeded).toBe(false);
            expect(status.warningThreshold).toBe(false);
        });

        it('returns unlimited budget when budget_usd is null', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: null, spent_usd: '50.00' });

            const status = await tracker.getProjectBudget('proj-1');

            expect(status.budgetUsd).toBeNull();
            expect(status.remainingUsd).toBeNull();
            expect(status.exceeded).toBe(false);
            expect(status.warningThreshold).toBe(false);
        });

        it('returns exceeded=true when over budget', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '12.50' });

            const status = await tracker.getProjectBudget('proj-1');

            expect(status.exceeded).toBe(true);
            expect(status.remainingUsd).toBeCloseTo(-2.5);
        });

        it('returns warningThreshold=true at 80% budget', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '80.00' });

            const status = await tracker.getProjectBudget('proj-1');

            expect(status.warningThreshold).toBe(true);
            expect(status.exceeded).toBe(false);
        });

        it('returns warningThreshold=true at 90% budget', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '90.00' });

            const status = await tracker.getProjectBudget('proj-1');

            expect(status.warningThreshold).toBe(true);
        });

        it('does not trigger warning below 80%', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '79.99' });

            const status = await tracker.getProjectBudget('proj-1');

            expect(status.warningThreshold).toBe(false);
        });
    });

    // ── setBudget ───────────────────────────────────────────────────────────

    describe('setBudget()', () => {
        it('updates the budget_usd column', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            await tracker.setBudget('proj-1', 250.00);

            expect(mockDb.query).toHaveBeenCalledWith(
                'UPDATE projects SET budget_usd = $1 WHERE id = $2',
                [250.00, 'proj-1']
            );
        });
    });

    // ── recordCost ──────────────────────────────────────────────────────────

    describe('recordCost()', () => {
        it('increments spent_usd and returns updated status', async () => {
            // Increment query
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // getProjectBudget query
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '30.50' });

            const status = await tracker.recordCost('proj-1', 0.05);

            expect(mockDb.query).toHaveBeenCalledWith(
                'UPDATE projects SET spent_usd = spent_usd + $1 WHERE id = $2',
                [0.05, 'proj-1']
            );
            expect(status.spentUsd).toBeCloseTo(30.5);
        });

        it('emits cost.warning event when at 80% budget', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '82.00' });

            await tracker.recordCost('proj-1', 2.00);

            const warningEvent = eventBus.publishedEvents.find(
                (e) => e.channel === 'cost.warning'
            );
            expect(warningEvent).toBeDefined();
            expect(warningEvent!.event.data.budgetUsd).toBe(100);
        });

        it('emits cost.exceeded event when over budget', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '50.00', spent_usd: '52.00' });

            await tracker.recordCost('proj-1', 3.00);

            const exceededEvent = eventBus.publishedEvents.find(
                (e) => e.channel === 'cost.exceeded'
            );
            expect(exceededEvent).toBeDefined();
            expect(exceededEvent!.event.data.spentUsd).toBeCloseTo(52);
        });

        it('does not emit events for unlimited budgets', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: null, spent_usd: '500.00' });

            await tracker.recordCost('proj-1', 10.00);

            expect(eventBus.publishedEvents).toHaveLength(0);
        });

        it('does not emit events when under threshold', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '20.00' });

            await tracker.recordCost('proj-1', 0.50);

            expect(eventBus.publishedEvents).toHaveLength(0);
        });

        // TD-002: idempotency — events should only fire on threshold *transitions*
        it('emits cost.exceeded only once across repeated post-budget calls', async () => {
            // Three consecutive recordCost calls all landing in exceeded state
            for (let i = 0; i < 3; i += 1) {
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '15.00' });
                await tracker.recordCost('proj-1', 1.0);
            }

            const exceededEvents = eventBus.publishedEvents.filter(
                (e) => e.channel === 'cost.exceeded'
            );
            expect(exceededEvents).toHaveLength(1);
        });

        it('emits cost.warning only once while in warning band', async () => {
            for (let i = 0; i < 3; i += 1) {
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
                mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '85.00' });
                await tracker.recordCost('proj-1', 1.0);
            }

            const warningEvents = eventBus.publishedEvents.filter(
                (e) => e.channel === 'cost.warning'
            );
            expect(warningEvents).toHaveLength(1);
        });

        it('re-emits cost.exceeded after resetThresholdState (cap raised)', async () => {
            // First exceed
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '12.00' });
            await tracker.recordCost('proj-1', 1.0);

            // Suppressed
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '13.00' });
            await tracker.recordCost('proj-1', 1.0);

            // Operator raises cap — state reset clears idempotency gates
            tracker.resetThresholdState('proj-1');

            // Still exceeded after reset → should re-emit once
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '14.00' });
            await tracker.recordCost('proj-1', 1.0);

            const exceededEvents = eventBus.publishedEvents.filter(
                (e) => e.channel === 'cost.exceeded'
            );
            expect(exceededEvents).toHaveLength(2);
        });

        it('re-emits cost.exceeded if status drops below warning and returns', async () => {
            // Enter exceeded
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '12.00' });
            await tracker.recordCost('proj-1', 1.0);

            // Drop below warning (e.g., budget raised to $100)
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '12.00' });
            await tracker.recordCost('proj-1', 0);

            // Return to exceeded
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '12.00' });
            await tracker.recordCost('proj-1', 0);

            const exceededEvents = eventBus.publishedEvents.filter(
                (e) => e.channel === 'cost.exceeded'
            );
            expect(exceededEvents).toHaveLength(2);
        });
    });

    // ── enforceBudget ───────────────────────────────────────────────────────

    describe('enforceBudget()', () => {
        it('does not throw when under budget', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '100.00', spent_usd: '50.00' });

            await expect(tracker.enforceBudget('proj-1')).resolves.not.toThrow();
        });

        it('does not throw for unlimited budget', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: null, spent_usd: '999.00' });

            await expect(tracker.enforceBudget('proj-1')).resolves.not.toThrow();
        });

        it('throws BudgetExceededError when over budget', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '12.00' });

            await expect(tracker.enforceBudget('proj-1')).rejects.toThrow(BudgetExceededError);
        });

        it('includes project and budget details in the error', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '15.00' });

            try {
                await tracker.enforceBudget('proj-1');
                expect.fail('Should have thrown');
            } catch (err) {
                const budgetErr = err as BudgetExceededError;
                expect(budgetErr.projectId).toBe('proj-1');
                expect(budgetErr.budgetUsd).toBe(10);
                expect(budgetErr.spentUsd).toBe(15);
                expect(budgetErr.message).toContain('$15.0000');
                expect(budgetErr.message).toContain('$10.00');
            }
        });
    });

    // ── Edge cases ──────────────────────────────────────────────────────────

    describe('edge cases', () => {
        it('works without event bus', async () => {
            const trackerNoEvents = new CostTracker();

            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '10.00', spent_usd: '11.00' });

            // Should not throw even though budget exceeded (no events to emit)
            const status = await trackerNoEvents.recordCost('proj-1', 1.00);
            expect(status.exceeded).toBe(true);
        });

        it('handles zero budget gracefully', async () => {
            mockDb.getOne.mockResolvedValueOnce({ budget_usd: '0.00', spent_usd: '0.001' });

            const status = await tracker.getProjectBudget('proj-1');

            expect(status.exceeded).toBe(true);
            expect(status.budgetUsd).toBe(0);
        });
    });
});
