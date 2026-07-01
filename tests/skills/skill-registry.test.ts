/**
 * SkillRegistry unit tests.
 *
 * Validates query sanitization, parameter binding, fallback path, and
 * no-op stubs. All DB calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock db/client ──────────────────────────────────────

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

import { SkillRegistry, sanitizeQuery } from '../../src/skills/skill-registry';

// ── Fixtures ────────────────────────────────────────────

function makeRankedRow(score: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'id-1',
        name: 'retry-with-backoff',
        description: 'Retry with exponential backoff',
        body: 'body',
        tags: ['retry', 'resilience'],
        source: 'imported',
        parent_skill_ids: [],
        version: 1,
        usage_count: 0,
        embedding: null,
        created_at: '2026-04-21T00:00:00Z',
        updated_at: '2026-04-21T00:00:00Z',
        score,
        ...overrides,
    };
}

// ── sanitizeQuery ───────────────────────────────────────

describe('sanitizeQuery()', () => {
    it('returns null for empty / whitespace / single-char input', () => {
        expect(sanitizeQuery('')).toBeNull();
        expect(sanitizeQuery('   ')).toBeNull();
        expect(sanitizeQuery('a')).toBeNull();
        expect(sanitizeQuery('!!!')).toBeNull();
    });

    it('produces an AND-joined prefix-matching tsquery', () => {
        expect(sanitizeQuery('retry backoff')).toBe('retry:* & backoff:*');
    });

    it('lowercases and splits on punctuation', () => {
        expect(sanitizeQuery('Retry, With--Backoff!')).toBe('retry:* & with:* & backoff:*');
    });

    it('drops tokens shorter than 2 chars', () => {
        expect(sanitizeQuery('a retry x')).toBe('retry:*');
    });
});

// ── search ──────────────────────────────────────────────

describe('SkillRegistry.search()', () => {
    beforeEach(() => mockDb.reset());

    it('returns empty array without hitting the DB when query is empty', async () => {
        const reg = new SkillRegistry();
        const results = await reg.search('   ');
        expect(results).toEqual([]);
        expect(mockDb.getMany).not.toHaveBeenCalled();
    });

    it('calls getMany with ts_rank SQL and sanitized query', async () => {
        mockDb.getMany.mockResolvedValueOnce([makeRankedRow(0.5)]);
        const reg = new SkillRegistry();
        const results = await reg.search('retry backoff', { limit: 5 });

        expect(mockDb.getMany).toHaveBeenCalledOnce();
        const [sql, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('ts_rank');
        expect(sql).toContain('to_tsquery');
        expect(params[0]).toBe('retry:* & backoff:*');
        expect(params[1]).toBeNull();   // no tag filter
        expect(params[2]).toBeNull();   // no source filter
        expect(params[4]).toBe(5);      // limit

        expect(results).toHaveLength(1);
        expect(results[0].skill.name).toBe('retry-with-backoff');
        expect(results[0].score).toBe(0.5);
        expect(Object.isFrozen(results)).toBe(true);
        expect(Object.isFrozen(results[0].skill)).toBe(true);
    });

    it('clamps limit to [1, 100]', async () => {
        mockDb.getMany.mockResolvedValueOnce([]);
        const reg = new SkillRegistry();

        await reg.search('retry', { limit: 0 });
        const [, params0] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(params0[4]).toBe(1);

        mockDb.reset();
        mockDb.getMany.mockResolvedValueOnce([]);
        await reg.search('retry', { limit: 10_000 });
        const [, paramsBig] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(paramsBig[4]).toBe(100);
    });

    it('propagates tags + source filters as parameters', async () => {
        mockDb.getMany.mockResolvedValueOnce([]);
        const reg = new SkillRegistry();
        await reg.search('retry', { tags: ['a', 'b'], source: 'imported' });
        const [, params] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
        expect(params[1]).toEqual(['a', 'b']);
        expect(params[2]).toBe('imported');
    });

    it('coerces numeric string scores', async () => {
        mockDb.getMany.mockResolvedValueOnce([makeRankedRow(0 as number, { score: '0.75' })]);
        const reg = new SkillRegistry();
        const results = await reg.search('retry');
        expect(results[0].score).toBe(0.75);
    });

    it('falls back to ILIKE when ts_rank throws', async () => {
        mockDb.getMany
            .mockRejectedValueOnce(new Error('to_tsquery not supported'))
            .mockResolvedValueOnce([makeRankedRow(3)]);

        const reg = new SkillRegistry();
        const results = await reg.search('retry');

        expect(mockDb.getMany).toHaveBeenCalledTimes(2);
        const [sqlFallback, paramsFallback] = mockDb.getMany.mock.calls[1] as [string, unknown[]];
        expect(sqlFallback).toContain('LIKE $1');
        expect(paramsFallback[0]).toBe('%retry%');
        expect(results).toHaveLength(1);
        expect(results[0].score).toBe(3);
    });
});

// ── pin / unpin stubs ───────────────────────────────────

describe('SkillRegistry.pin() / unpin()', () => {
    beforeEach(() => mockDb.reset());

    it('pin is a no-op (runs SELECT 1)', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const reg = new SkillRegistry();
        await reg.pin('id-1');
        const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toBe('SELECT 1');
    });

    it('unpin is a no-op (runs SELECT 1)', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const reg = new SkillRegistry();
        await reg.unpin('id-1');
        const [sql] = mockDb.query.mock.calls[0] as [string, unknown[]];
        expect(sql).toBe('SELECT 1');
    });
});
