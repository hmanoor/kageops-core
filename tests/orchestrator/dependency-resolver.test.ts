/**
 * DependencyResolver unit tests
 *
 * Tests topological sort, wave generation, cycle detection,
 * and database-backed ready-task queries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskNode } from '../../src/orchestrator/dependency-resolver';

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
import { DependencyResolver, CyclicDependencyError } from '../../src/orchestrator/dependency-resolver';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(id: string, dependsOn: readonly string[] = [], status = 'pending'): TaskNode {
    return { id, dependsOn, status };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DependencyResolver', () => {
    let resolver: DependencyResolver;

    beforeEach(() => {
        mockDb.reset();
        resolver = new DependencyResolver();
    });

    // ── resolve() — topological sort ────────────────────────────────────────

    describe('resolve()', () => {
        it('returns empty array for empty input', () => {
            const waves = resolver.resolve([]);
            expect(waves).toEqual([]);
        });

        it('returns single wave when no tasks have dependencies', () => {
            const tasks = [
                makeNode('a'),
                makeNode('b'),
                makeNode('c'),
            ];

            const waves = resolver.resolve(tasks);

            expect(waves).toHaveLength(1);
            expect(waves[0].waveIndex).toBe(0);
            expect(waves[0].taskIds).toHaveLength(3);
            expect(waves[0].taskIds).toContain('a');
            expect(waves[0].taskIds).toContain('b');
            expect(waves[0].taskIds).toContain('c');
        });

        it('resolves a linear chain into sequential waves', () => {
            // A → B → C
            const tasks = [
                makeNode('a'),
                makeNode('b', ['a']),
                makeNode('c', ['b']),
            ];

            const waves = resolver.resolve(tasks);

            expect(waves).toHaveLength(3);
            expect(waves[0].taskIds).toEqual(['a']);
            expect(waves[1].taskIds).toEqual(['b']);
            expect(waves[2].taskIds).toEqual(['c']);
        });

        it('resolves a diamond graph into 3 waves', () => {
            //   A
            //  / \
            // B   C
            //  \ /
            //   D
            const tasks = [
                makeNode('a'),
                makeNode('b', ['a']),
                makeNode('c', ['a']),
                makeNode('d', ['b', 'c']),
            ];

            const waves = resolver.resolve(tasks);

            expect(waves).toHaveLength(3);
            expect(waves[0].taskIds).toEqual(['a']);
            expect(waves[1].taskIds).toHaveLength(2);
            expect(waves[1].taskIds).toContain('b');
            expect(waves[1].taskIds).toContain('c');
            expect(waves[2].taskIds).toEqual(['d']);
        });

        it('resolves a complex graph with mixed parallel and sequential', () => {
            // A, B (no deps)
            // C depends on A
            // D depends on A, B
            // E depends on C, D
            const tasks = [
                makeNode('a'),
                makeNode('b'),
                makeNode('c', ['a']),
                makeNode('d', ['a', 'b']),
                makeNode('e', ['c', 'd']),
            ];

            const waves = resolver.resolve(tasks);

            expect(waves).toHaveLength(3);
            expect(waves[0].taskIds).toHaveLength(2);
            expect(waves[0].taskIds).toContain('a');
            expect(waves[0].taskIds).toContain('b');
            expect(waves[1].taskIds).toHaveLength(2);
            expect(waves[1].taskIds).toContain('c');
            expect(waves[1].taskIds).toContain('d');
            expect(waves[2].taskIds).toEqual(['e']);
        });

        it('ignores dependencies not in the input set (external deps)', () => {
            const tasks = [
                makeNode('a', ['external-1']),
                makeNode('b', ['a', 'external-2']),
            ];

            const waves = resolver.resolve(tasks);

            expect(waves).toHaveLength(2);
            expect(waves[0].taskIds).toEqual(['a']);
            expect(waves[1].taskIds).toEqual(['b']);
        });

        it('handles single task with no dependencies', () => {
            const waves = resolver.resolve([makeNode('solo')]);

            expect(waves).toHaveLength(1);
            expect(waves[0].taskIds).toEqual(['solo']);
        });

        it('preserves wave index numbering', () => {
            const tasks = [
                makeNode('a'),
                makeNode('b', ['a']),
                makeNode('c', ['b']),
                makeNode('d', ['c']),
            ];

            const waves = resolver.resolve(tasks);

            expect(waves.map((w) => w.waveIndex)).toEqual([0, 1, 2, 3]);
        });
    });

    // ── Cycle detection ─────────────────────────────────────────────────────

    describe('cycle detection', () => {
        it('detects a simple 2-node cycle', () => {
            const tasks = [
                makeNode('a', ['b']),
                makeNode('b', ['a']),
            ];

            expect(() => resolver.resolve(tasks)).toThrow(CyclicDependencyError);

            try {
                resolver.resolve(tasks);
            } catch (err) {
                const cycleErr = err as CyclicDependencyError;
                expect(cycleErr.cyclePath.length).toBeGreaterThanOrEqual(2);
                expect(cycleErr.message).toContain('Cyclic dependency detected');
            }
        });

        it('detects a 3-node cycle', () => {
            // A → B → C → A
            const tasks = [
                makeNode('a', ['c']),
                makeNode('b', ['a']),
                makeNode('c', ['b']),
            ];

            expect(() => resolver.resolve(tasks)).toThrow(CyclicDependencyError);

            try {
                resolver.resolve(tasks);
            } catch (err) {
                const cycleErr = err as CyclicDependencyError;
                expect(cycleErr.cyclePath).toHaveLength(4); // A → B → C → A
            }
        });

        it('detects a cycle in a partially-valid graph', () => {
            // D and E are fine, but B → C → B is a cycle
            const tasks = [
                makeNode('d'),
                makeNode('e', ['d']),
                makeNode('b', ['c', 'd']),
                makeNode('c', ['b']),
            ];

            expect(() => resolver.resolve(tasks)).toThrow(CyclicDependencyError);
        });

        it('includes the cycle path in the error', () => {
            const tasks = [
                makeNode('x', ['z']),
                makeNode('y', ['x']),
                makeNode('z', ['y']),
            ];

            try {
                resolver.resolve(tasks);
                expect.fail('Should have thrown');
            } catch (err) {
                const cycleErr = err as CyclicDependencyError;
                // Cycle path should contain all 3 nodes plus repeat of first
                expect(cycleErr.cyclePath.length).toBe(4);
                expect(cycleErr.cyclePath[0]).toBe(cycleErr.cyclePath[cycleErr.cyclePath.length - 1]);
            }
        });

        it('does not detect a cycle when self-dependency references external task', () => {
            // 'a' depends on 'external' which is not in the set
            const tasks = [makeNode('a', ['external'])];
            const waves = resolver.resolve(tasks);
            expect(waves).toHaveLength(1);
        });
    });

    // ── getReadyTasks() ─────────────────────────────────────────────────────

    describe('getReadyTasks()', () => {
        it('returns empty when no pending tasks', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            const result = await resolver.getReadyTasks('proj-1');

            expect(result.readyIds).toEqual([]);
            expect(result.blockedIds).toEqual([]);
        });

        it('returns all pending tasks when none have dependencies', async () => {
            mockDb.getMany.mockResolvedValueOnce([
                { id: 'task-1', depends_on: [] },
                { id: 'task-2', depends_on: null },
                { id: 'task-3', depends_on: [] },
            ]);

            const result = await resolver.getReadyTasks('proj-1');

            expect(result.readyIds).toEqual(['task-1', 'task-2', 'task-3']);
            expect(result.blockedIds).toEqual([]);
        });

        it('marks tasks with incomplete deps as blocked', async () => {
            mockDb.getMany
                // Pending tasks query
                .mockResolvedValueOnce([
                    { id: 'task-1', depends_on: [] },
                    { id: 'task-2', depends_on: ['task-1'] },
                    { id: 'task-3', depends_on: ['dep-x'] },
                ])
                // Dependency statuses query
                .mockResolvedValueOnce([
                    { id: 'task-1', status: 'pending' },
                    { id: 'dep-x', status: 'assigned' },
                ]);

            const result = await resolver.getReadyTasks('proj-1');

            expect(result.readyIds).toEqual(['task-1']);
            expect(result.blockedIds).toContain('task-2');
            expect(result.blockedIds).toContain('task-3');
        });

        it('treats missing dep references as completed (external)', async () => {
            mockDb.getMany
                .mockResolvedValueOnce([
                    { id: 'task-1', depends_on: ['unknown-dep'] },
                ])
                .mockResolvedValueOnce([]); // dep not found

            const result = await resolver.getReadyTasks('proj-1');

            expect(result.readyIds).toEqual(['task-1']);
            expect(result.blockedIds).toEqual([]);
        });

        it('unblocks tasks when all deps are completed', async () => {
            mockDb.getMany
                .mockResolvedValueOnce([
                    { id: 'task-2', depends_on: ['task-1'] },
                    { id: 'task-3', depends_on: ['task-1', 'task-2'] },
                ])
                .mockResolvedValueOnce([
                    { id: 'task-1', status: 'completed' },
                    { id: 'task-2', status: 'pending' },
                ]);

            const result = await resolver.getReadyTasks('proj-1');

            expect(result.readyIds).toEqual(['task-2']);
            expect(result.blockedIds).toEqual(['task-3']); // task-2 not completed yet
        });

        it('passes phase filter to the query', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            await resolver.getReadyTasks('proj-1', 'development');

            const callArgs = mockDb.getMany.mock.calls[0];
            const sql = callArgs[0] as string;
            expect(sql).toContain('phase = $2');
            expect(callArgs[1]).toEqual(['proj-1', 'development']);
        });

        it('works without phase filter', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            await resolver.getReadyTasks('proj-1');

            const callArgs = mockDb.getMany.mock.calls[0];
            const sql = callArgs[0] as string;
            expect(sql).not.toContain('phase = $2');
            expect(callArgs[1]).toEqual(['proj-1']);
        });

        it('handles tasks with multiple completed deps correctly', async () => {
            mockDb.getMany
                .mockResolvedValueOnce([
                    { id: 'task-final', depends_on: ['task-a', 'task-b', 'task-c'] },
                ])
                .mockResolvedValueOnce([
                    { id: 'task-a', status: 'completed' },
                    { id: 'task-b', status: 'completed' },
                    { id: 'task-c', status: 'completed' },
                ]);

            const result = await resolver.getReadyTasks('proj-1');

            expect(result.readyIds).toEqual(['task-final']);
        });

        it('treats failed deps as satisfied so dependents are not permanently blocked', async () => {
            mockDb.getMany
                .mockResolvedValueOnce([
                    { id: 'task-final', depends_on: ['task-a', 'task-b', 'task-c'] },
                ])
                .mockResolvedValueOnce([
                    { id: 'task-a', status: 'completed' },
                    { id: 'task-b', status: 'failed' },
                    { id: 'task-c', status: 'completed' },
                ]);

            const result = await resolver.getReadyTasks('proj-1');

            // Failed deps are treated as satisfied — pipeline continues
            expect(result.readyIds).toEqual(['task-final']);
            expect(result.blockedIds).toEqual([]);
        });

        it('blocks task when dep is still in progress', async () => {
            mockDb.getMany
                .mockResolvedValueOnce([
                    { id: 'task-final', depends_on: ['task-a', 'task-b'] },
                ])
                .mockResolvedValueOnce([
                    { id: 'task-a', status: 'completed' },
                    { id: 'task-b', status: 'in_progress' },
                ]);

            const result = await resolver.getReadyTasks('proj-1');

            expect(result.readyIds).toEqual([]);
            expect(result.blockedIds).toEqual(['task-final']);
        });
    });
});
