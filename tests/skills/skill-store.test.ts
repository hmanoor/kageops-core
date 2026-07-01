/**
 * SkillStore unit tests.
 *
 * All db/client calls are mocked — no live Postgres required.
 * Each test is independent; mocks are reset in beforeEach.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock db/client (hoisted) ─────────────────────────────

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
        initDatabase: vi.fn(async () => undefined),
        testConnection: vi.fn(async () => true),
        closePool: vi.fn(async () => undefined),
        getPool: vi.fn(() => ({ query: queryFn, end: vi.fn() })),
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
import { SkillStore } from '../../src/skills/skill-store';

// ── Fixtures ─────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'test-skill',
        description: 'desc',
        body: 'body',
        tags: ['a', 'b'],
        source: 'captured',
        parent_skill_ids: [],
        version: 1,
        usage_count: 0,
        embedding: null,
        created_at: '2026-04-21T00:00:00Z',
        updated_at: '2026-04-21T00:00:00Z',
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────

describe('SkillStore', () => {
    beforeEach(() => {
        mockDb.reset();
    });

    // ── create ─────────────────────────────────────────

    describe('create()', () => {
        it('inserts a new row and returns a frozen Skill', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 });
            const store = new SkillStore();

            const skill = await store.create({
                name: 'test-skill',
                description: 'desc',
                body: 'body',
                tags: ['a', 'b'],
            });

            expect(mockDb.query).toHaveBeenCalledOnce();
            const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(sql).toContain('INSERT INTO skills');
            expect(sql).toContain('RETURNING');
            expect(params[0]).toBe('test-skill');
            expect(params[3]).toEqual(['a', 'b']);
            expect(params[4]).toBe('captured');

            expect(skill.id).toBe('11111111-1111-1111-1111-111111111111');
            expect(skill.tags).toEqual(['a', 'b']);
            expect(Object.isFrozen(skill)).toBe(true);
            expect(Object.isFrozen(skill.tags)).toBe(true);
        });

        it('defaults source to captured when omitted', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 });
            const store = new SkillStore();
            await store.create({ name: 'n', description: 'd', body: 'b' });
            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(params[4]).toBe('captured');
        });

        it('throws when insert returns no row', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
            const store = new SkillStore();
            await expect(
                store.create({ name: 'n', description: 'd', body: 'b' })
            ).rejects.toThrow(/Insert returned no row/);
        });

        it('normalizes unknown source values to "imported"', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [makeRow({ source: 'nonsense' })],
                rowCount: 1,
            });
            const store = new SkillStore();
            const skill = await store.create({ name: 'n', description: 'd', body: 'b' });
            expect(skill.source).toBe('imported');
        });
    });

    // ── update ─────────────────────────────────────────

    describe('update()', () => {
        it('bumps version via SQL and returns updated Skill', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [makeRow({ version: 2 })],
                rowCount: 1,
            });
            const store = new SkillStore();

            const result = await store.update('test-skill', { description: 'new' });

            const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(sql).toContain('UPDATE skills');
            expect(sql).toContain('version          = version + 1');
            expect(params[0]).toBe('test-skill');
            expect(params[1]).toBe('new');
            expect(result).not.toBeNull();
            expect(result!.version).toBe(2);
        });

        it('passes null for fields not provided (COALESCE keeps existing)', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 });
            const store = new SkillStore();
            await store.update('test-skill', { body: 'updated body' });
            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            // [name, description, body, tags, source, parentSkillIds]
            expect(params[1]).toBeNull();
            expect(params[2]).toBe('updated body');
            expect(params[3]).toBeNull();
            expect(params[4]).toBeNull();
            expect(params[5]).toBeNull();
        });

        it('returns null when no row matches', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
            const store = new SkillStore();
            const result = await store.update('missing', { body: 'x' });
            expect(result).toBeNull();
        });
    });

    // ── getById / getByName ────────────────────────────

    describe('getById() / getByName()', () => {
        it('getById returns null when row absent', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);
            const store = new SkillStore();
            const result = await store.getById('deadbeef-dead-beef-dead-beefdeadbeef');
            expect(result).toBeNull();
        });

        it('getById returns frozen Skill when found', async () => {
            mockDb.getOne.mockResolvedValueOnce(makeRow());
            const store = new SkillStore();
            const result = await store.getById('11111111-1111-1111-1111-111111111111');
            expect(result).not.toBeNull();
            expect(Object.isFrozen(result)).toBe(true);
            expect(result!.name).toBe('test-skill');
        });

        it('getByName passes the name parameter', async () => {
            mockDb.getOne.mockResolvedValueOnce(makeRow());
            const store = new SkillStore();
            await store.getByName('test-skill');
            const [sql, params] = mockDb.getOne.mock.calls[0] as [string, unknown[]];
            expect(sql).toContain('WHERE name = $1');
            expect(params[0]).toBe('test-skill');
        });
    });

    // ── list / delete ──────────────────────────────────

    describe('list() / delete()', () => {
        it('list clamps limit to valid range', async () => {
            mockDb.getMany.mockResolvedValueOnce([]);
            const store = new SkillStore();

            await store.list(0);
            const [, params0] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
            expect(params0[0]).toBe(1);

            mockDb.reset();
            mockDb.getMany.mockResolvedValueOnce([]);
            await store.list(100_000);
            const [, paramsLarge] = mockDb.getMany.mock.calls[0] as [string, unknown[]];
            expect(paramsLarge[0]).toBe(500);
        });

        it('list returns frozen array of skills', async () => {
            mockDb.getMany.mockResolvedValueOnce([makeRow(), makeRow({ id: '22' })]);
            const store = new SkillStore();
            const skills = await store.list();
            expect(skills).toHaveLength(2);
            expect(Object.isFrozen(skills)).toBe(true);
        });

        it('delete returns true on row removed', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            const store = new SkillStore();
            const ok = await store.delete('abc');
            expect(ok).toBe(true);
        });

        it('delete returns false when no rows removed', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
            const store = new SkillStore();
            const ok = await store.delete('abc');
            expect(ok).toBe(false);
        });
    });

    // ── recordEvolution ────────────────────────────────

    describe('recordEvolution()', () => {
        it('inserts into skill_evolutions with provided fields', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    id: 'e1',
                    skill_id: 's1',
                    evolution_type: 'captured',
                    trigger_task_id: 't1',
                    notes: 'hello',
                    created_at: '2026-04-21T00:00:00Z',
                }],
                rowCount: 1,
            });
            const store = new SkillStore();

            const evo = await store.recordEvolution('s1', 'captured', {
                triggerTaskId: 't1',
                notes: 'hello',
            });

            const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(sql).toContain('INSERT INTO skill_evolutions');
            expect(params).toEqual(['s1', 'captured', 't1', 'hello']);
            expect(evo.evolutionType).toBe('captured');
            expect(evo.notes).toBe('hello');
            expect(Object.isFrozen(evo)).toBe(true);
        });

        it('defaults triggerTaskId=null and notes="" when not given', async () => {
            mockDb.query.mockResolvedValueOnce({
                rows: [{
                    id: 'e1',
                    skill_id: 's1',
                    evolution_type: 'derived',
                    trigger_task_id: null,
                    notes: '',
                    created_at: '2026-04-21T00:00:00Z',
                }],
                rowCount: 1,
            });
            const store = new SkillStore();
            await store.recordEvolution('s1', 'derived');
            const [, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(params[2]).toBeNull();
            expect(params[3]).toBe('');
        });
    });

    // ── incrementUsage ─────────────────────────────────

    describe('incrementUsage()', () => {
        it('runs the expected UPDATE', async () => {
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            const store = new SkillStore();
            await store.incrementUsage('id-1');
            const [sql, params] = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(sql).toContain('usage_count = usage_count + 1');
            expect(params[0]).toBe('id-1');
        });
    });
});
