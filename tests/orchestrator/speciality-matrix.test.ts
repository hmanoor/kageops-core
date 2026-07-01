/**
 * SpecialityMatrix unit tests
 *
 * All db/client calls are mocked — no live Postgres required.
 * Each test is independent; mocks are reset in beforeEach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Import AFTER mock is registered so the module picks up the mock.
import { SpecialityMatrix } from '../../src/orchestrator/speciality-matrix';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMatrix(): SpecialityMatrix {
    return new SpecialityMatrix();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SpecialityMatrix', () => {
    beforeEach(() => {
        mockDb.reset();
    });

    // ── getBestAgent ─────────────────────────────────────────────────────────

    describe('getBestAgent()', () => {
        it('calls getOne with correct SQL and params, returns highest-scoring agent', async () => {
            const expected = { agent: 'forge', score: 8.5 };
            mockDb.getOne.mockResolvedValueOnce(expected);

            const matrix = makeMatrix();
            const result = await matrix.getBestAgent('coding');

            expect(mockDb.getOne).toHaveBeenCalledOnce();

            const [sql, params] = mockDb.getOne.mock.calls[0] as [string, unknown[]];
            expect(sql).toMatch(/WHERE skill = \$1/);
            expect(sql).toMatch(/ORDER BY score DESC/);
            expect(sql).toMatch(/LIMIT 1/);
            expect(params).toEqual(['coding']);

            expect(result).toEqual(expected);
        });

        it('returns null when getOne returns null (no agents have the skill)', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const matrix = makeMatrix();
            const result = await matrix.getBestAgent('unknown-skill');

            expect(result).toBeNull();
        });
    });

    // ── getTopAgents ─────────────────────────────────────────────────────────

    describe('getTopAgents()', () => {
        it('calls getMany with skill and limit parameters', async () => {
            const agents = [
                { agent: 'forge', score: 8.0 },
                { agent: 'vigil', score: 7.2 },
                { agent: 'aegis', score: 6.5 },
            ];
            mockDb.getMany.mockResolvedValueOnce(agents);

            const matrix = makeMatrix();
            const result = await matrix.getTopAgents('devops', 3);

            expect(mockDb.getMany).toHaveBeenCalledOnce();

            const [sql, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
            expect(sql).toMatch(/WHERE skill = \$1/);
            expect(sql).toMatch(/ORDER BY score DESC/);
            expect(sql).toMatch(/LIMIT \$2/);
            expect(params).toEqual(['devops', 3]);

            expect(result).toEqual(agents);
        });

        it('uses default limit of 3 when no limit argument is provided', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            const matrix = makeMatrix();
            await matrix.getTopAgents('research');

            const [, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
            expect(params).toEqual(['research', 3]);
        });
    });

    // ── updateScore ──────────────────────────────────────────────────────────

    describe('updateScore()', () => {
        it('clamps score above MAX (15 → 9.0) before passing to query', async () => {
            const matrix = makeMatrix();
            await matrix.updateScore('forge', 'coding', 15);

            expect(mockDb.query).toHaveBeenCalledOnce();
            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            // Third param is the clamped score
            expect(params[2]).toBe(9.0);
        });

        it('clamps score below MIN (-3 → 0.0) before passing to query', async () => {
            const matrix = makeMatrix();
            await matrix.updateScore('vigil', 'testing', -3);

            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(params[2]).toBe(0.0);
        });

        it('uses INSERT … ON CONFLICT DO UPDATE query', async () => {
            const matrix = makeMatrix();
            await matrix.updateScore('scout', 'research', 7.5);

            const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(sql).toMatch(/INSERT INTO speciality_matrix/i);
            expect(sql).toMatch(/ON CONFLICT/i);
            expect(sql).toMatch(/DO UPDATE/i);
        });

        it('passes agent, skill, and valid score as query parameters', async () => {
            const matrix = makeMatrix();
            await matrix.updateScore('blueprint', 'architecture', 6.0);

            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(params[0]).toBe('blueprint');
            expect(params[1]).toBe('architecture');
            expect(params[2]).toBe(6.0);
        });
    });

    // ── recordTaskOutcome ────────────────────────────────────────────────────

    describe('recordTaskOutcome()', () => {
        it('applies EMA on success: newScore = old * 0.7 + 9.0 * 0.3', async () => {
            mockDb.getOne.mockResolvedValueOnce({ score: 5.0 });

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('forge', 'coding', true);

            // EMA: 5.0 * 0.7 + 9.0 * 0.3 = 3.5 + 2.7 = 6.2
            const expectedScore = 5.0 * 0.7 + 9.0 * 0.3;

            expect(mockDb.query).toHaveBeenCalledOnce();
            const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(sql).toMatch(/UPDATE speciality_matrix/i);
            expect((params[0] as number)).toBeCloseTo(expectedScore, 10);
        });

        it('applies EMA on failure: newScore = old * 0.7 + 1.0 * 0.3', async () => {
            mockDb.getOne.mockResolvedValueOnce({ score: 7.0 });

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('forge', 'coding', false);

            // EMA: 7.0 * 0.7 + 1.0 * 0.3 = 4.9 + 0.3 = 5.2
            const expectedScore = 7.0 * 0.7 + 1.0 * 0.3;

            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect((params[0] as number)).toBeCloseTo(expectedScore, 10);
        });

        it('uses qualityScore in EMA instead of 9.0/1.0 when provided', async () => {
            mockDb.getOne.mockResolvedValueOnce({ score: 6.0 });

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('vigil', 'testing', true, 7.5);

            // EMA: 6.0 * 0.7 + 7.5 * 0.3 = 4.2 + 2.25 = 6.45
            const expectedScore = 6.0 * 0.7 + 7.5 * 0.3;

            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect((params[0] as number)).toBeCloseTo(expectedScore, 10);
        });

        it('creates new entry with initial score 6.0 when entry is missing and success=true', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('scout', 'research', true);

            expect(mockDb.query).toHaveBeenCalledOnce();
            const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(sql).toMatch(/INSERT INTO speciality_matrix/i);
            expect(params[2]).toBe(6.0);
        });

        it('creates new entry with initial score 3.0 when entry is missing and success=false', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('scout', 'research', false);

            const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(sql).toMatch(/INSERT INTO speciality_matrix/i);
            expect(params[2]).toBe(3.0);
        });

        it('increments task_success_count on success', async () => {
            mockDb.getOne.mockResolvedValueOnce({ score: 5.0 });

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('forge', 'coding', true);

            const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            // params: [newScore, successIncrement, failureIncrement, agent, skill]
            expect(sql).toMatch(/task_success_count/);
            expect(params[1]).toBe(1); // successIncrement
            expect(params[2]).toBe(0); // failureIncrement
        });

        it('increments task_failure_count on failure', async () => {
            mockDb.getOne.mockResolvedValueOnce({ score: 5.0 });

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('forge', 'coding', false);

            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(params[1]).toBe(0); // successIncrement
            expect(params[2]).toBe(1); // failureIncrement
        });

        it('clamps EMA result to MAX_SCORE (9.0) when observation would push above', async () => {
            // High current + max observation — result should never exceed 9.0
            mockDb.getOne.mockResolvedValueOnce({ score: 9.0 });

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('forge', 'coding', true);

            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(params[0] as number).toBeLessThanOrEqual(9.0);
        });

        it('clamps EMA result to MIN_SCORE (0.0) when observation would push below', async () => {
            // Low current + min observation — result should never go below 0.0
            mockDb.getOne.mockResolvedValueOnce({ score: 0.0 });

            const matrix = makeMatrix();
            await matrix.recordTaskOutcome('forge', 'coding', false);

            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(params[0] as number).toBeGreaterThanOrEqual(0.0);
        });
    });

    // ── findSkillGaps ────────────────────────────────────────────────────────

    describe('findSkillGaps()', () => {
        it('returns skills where max score is below the threshold', async () => {
            mockDb.getMany.mockResolvedValueOnce([
                { skill: 'ml-ops' },
                { skill: 'blockchain' },
            ]);

            const matrix = makeMatrix();
            const result = await matrix.findSkillGaps(4.0);

            expect(result).toEqual(['ml-ops', 'blockchain']);
        });

        it('passes threshold as query parameter', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            const matrix = makeMatrix();
            await matrix.findSkillGaps(5.5);

            const [sql, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
            expect(sql).toMatch(/HAVING MAX\(score\) < \$1/);
            expect(params).toEqual([5.5]);
        });

        it('uses default threshold of 4.0 when no argument is provided', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            const matrix = makeMatrix();
            await matrix.findSkillGaps();

            const [, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
            expect(params).toEqual([4.0]);
        });

        it('returns empty array when all skills are above threshold', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            const matrix = makeMatrix();
            const result = await matrix.findSkillGaps(4.0);

            expect(result).toEqual([]);
        });
    });

    // ── getSummary ───────────────────────────────────────────────────────────

    describe('getSummary()', () => {
        it('returns aggregate per-agent data from getMany', async () => {
            const expected = [
                { agent: 'forge', skillCount: 5, avgScore: 7.8 },
                { agent: 'scout', skillCount: 3, avgScore: 6.5 },
            ];
            mockDb.getMany.mockResolvedValueOnce(expected);

            const matrix = makeMatrix();
            const result = await matrix.getSummary();

            expect(result).toEqual(expected);
        });

        it('queries speciality_matrix grouped by agent', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            const matrix = makeMatrix();
            await matrix.getSummary();

            const [sql] = mockDb.getMany.mock.calls[0] as [string, unknown[]?];
            expect(sql).toMatch(/FROM speciality_matrix/i);
            expect(sql).toMatch(/GROUP BY agent/i);
        });

        it('returns empty array when there are no agents in the matrix', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);

            const matrix = makeMatrix();
            const result = await matrix.getSummary();

            expect(result).toEqual([]);
        });
    });
});
