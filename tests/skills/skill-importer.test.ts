/**
 * SkillImporter unit tests.
 *
 * Exercises frontmatter parsing (pure) and the file-system import
 * pipeline (with a stubbed SkillStore — no real DB).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Mock db/client so nothing accidentally touches Postgres ──

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    return {
        query: queryFn,
        getOne: vi.fn(async () => null),
        getMany: vi.fn(async () => []),
        module: () => ({
            query: queryFn,
            getOne: vi.fn(async () => null),
            getMany: vi.fn(async () => []),
            initDatabase: vi.fn(async () => undefined),
            testConnection: vi.fn(async () => true),
            closePool: vi.fn(async () => undefined),
            getPool: vi.fn(() => ({ query: queryFn, end: vi.fn() })),
        }),
    };
});

vi.mock('../../src/db/client', () => mockDb.module());

import { SkillImporter, parseSkillFile } from '../../src/skills/skill-importer';
import type { Skill } from '../../src/skills/types';

// ── Helpers ─────────────────────────────────────────────

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return Object.freeze({
        id: 'id-1',
        name: 'fixture',
        description: 'fixture description',
        body: 'fixture body',
        tags: [],
        source: 'imported',
        parentSkillIds: [],
        version: 1,
        usageCount: 0,
        embedding: null,
        createdAt: '2026-04-21T00:00:00Z',
        updatedAt: '2026-04-21T00:00:00Z',
        ...overrides,
    }) as Skill;
}

interface StoreStub {
    readonly getByName: ReturnType<typeof vi.fn>;
    readonly create: ReturnType<typeof vi.fn>;
    readonly update: ReturnType<typeof vi.fn>;
    readonly recordEvolution: ReturnType<typeof vi.fn>;
}

function makeStoreStub(): StoreStub {
    return {
        getByName: vi.fn(async () => null),
        create: vi.fn(async (input: { name: string }): Promise<Skill> =>
            makeSkill({ name: input.name })
        ),
        update: vi.fn(async (name: string): Promise<Skill | null> => makeSkill({ name })),
        recordEvolution: vi.fn(async () => ({
            id: 'e1',
            skillId: 'id-1',
            evolutionType: 'captured' as const,
            triggerTaskId: null,
            notes: '',
            createdAt: '2026-04-21T00:00:00Z',
        })),
    };
}

function writeSkillFile(dir: string, name: string, content: string): void {
    const sub = path.join(dir, name);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'SKILL.md'), content, 'utf-8');
}

// ── parseSkillFile ──────────────────────────────────────

describe('parseSkillFile()', () => {
    it('parses frontmatter + body', () => {
        const content =
            '---\nname: my-skill\ndescription: One-liner\n---\nBody line 1\nBody line 2';
        const parsed = parseSkillFile(content);
        expect(parsed).not.toBeNull();
        expect(parsed!.name).toBe('my-skill');
        expect(parsed!.description).toBe('One-liner');
        expect(parsed!.body).toBe('Body line 1\nBody line 2');
        expect(parsed!.tags).toEqual([]);
    });

    it('parses comma-separated tags string', () => {
        const content = '---\nname: s\ndescription: d\ntags: a, b, c\n---\nbody';
        const parsed = parseSkillFile(content);
        expect(parsed!.tags).toEqual(['a', 'b', 'c']);
    });

    it('parses inline array tags', () => {
        const content = '---\nname: s\ndescription: d\ntags: [a, "b", c]\n---\nbody';
        const parsed = parseSkillFile(content);
        expect(parsed!.tags).toEqual(['a', 'b', 'c']);
    });

    it('handles double and single quoted values', () => {
        const content = '---\nname: "quoted-name"\ndescription: \'quoted desc\'\n---\nbody';
        const parsed = parseSkillFile(content);
        expect(parsed!.name).toBe('quoted-name');
        expect(parsed!.description).toBe('quoted desc');
    });

    it('returns null when no frontmatter block', () => {
        expect(parseSkillFile('just body text')).toBeNull();
    });

    it('returns null when name is missing', () => {
        expect(parseSkillFile('---\ndescription: d\n---\nbody')).toBeNull();
    });

    it('returns null when name is empty', () => {
        expect(parseSkillFile('---\nname:   \ndescription: d\n---\nbody')).toBeNull();
    });

    it('tolerates Windows CRLF line endings', () => {
        const content = '---\r\nname: win-skill\r\ndescription: d\r\n---\r\nbody';
        const parsed = parseSkillFile(content);
        expect(parsed).not.toBeNull();
        expect(parsed!.name).toBe('win-skill');
    });
});

// ── importFromClaudeDir ─────────────────────────────────

describe('SkillImporter.importFromClaudeDir()', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-skills-'));
    });

    afterEach(() => {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('returns zero counts when the dir does not exist', async () => {
        const store = makeStoreStub() as unknown as ConstructorParameters<typeof SkillImporter>[0];
        const importer = new SkillImporter(store);
        const missing = path.join(tmpDir, 'does-not-exist');
        const result = await importer.importFromClaudeDir(missing);
        expect(result).toEqual({ imported: 0, updated: 0, skipped: 0, errors: [] });
    });

    it('creates and records evolution for new skills', async () => {
        writeSkillFile(tmpDir, 'alpha',
            '---\nname: alpha\ndescription: first\n---\nbody one');
        writeSkillFile(tmpDir, 'beta',
            '---\nname: beta\ndescription: second\ntags: [x, y]\n---\nbody two');

        const store = makeStoreStub();
        const importer = new SkillImporter(store as unknown as ConstructorParameters<typeof SkillImporter>[0]);
        const result = await importer.importFromClaudeDir(tmpDir);

        expect(result.imported).toBe(2);
        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(0);
        expect(store.create).toHaveBeenCalledTimes(2);
        expect(store.recordEvolution).toHaveBeenCalledTimes(2);
        expect(store.update).not.toHaveBeenCalled();

        // All created with source=imported.
        for (const call of store.create.mock.calls) {
            const [input] = call as [{ source: string }];
            expect(input.source).toBe('imported');
        }
    });

    it('updates when body changes for an existing skill', async () => {
        writeSkillFile(tmpDir, 'alpha',
            '---\nname: alpha\ndescription: desc\n---\nnew body');

        const store = makeStoreStub();
        store.getByName.mockResolvedValueOnce(makeSkill({
            name: 'alpha',
            description: 'desc',
            body: 'OLD BODY',
        }));

        const importer = new SkillImporter(store as unknown as ConstructorParameters<typeof SkillImporter>[0]);
        const result = await importer.importFromClaudeDir(tmpDir);

        expect(result.updated).toBe(1);
        expect(result.imported).toBe(0);
        expect(store.update).toHaveBeenCalledOnce();
        const [name, input] = store.update.mock.calls[0] as [string, { body: string; source: string }];
        expect(name).toBe('alpha');
        expect(input.body).toBe('new body');
        expect(input.source).toBe('imported');
    });

    it('skips when the parsed content matches the stored skill exactly', async () => {
        writeSkillFile(tmpDir, 'alpha',
            '---\nname: alpha\ndescription: desc\ntags: [a, b]\n---\nbody');

        const store = makeStoreStub();
        store.getByName.mockResolvedValueOnce(makeSkill({
            name: 'alpha',
            description: 'desc',
            body: 'body',
            tags: Object.freeze(['a', 'b']),
        }));

        const importer = new SkillImporter(store as unknown as ConstructorParameters<typeof SkillImporter>[0]);
        const result = await importer.importFromClaudeDir(tmpDir);

        expect(result.skipped).toBe(1);
        expect(result.imported).toBe(0);
        expect(result.updated).toBe(0);
        expect(store.create).not.toHaveBeenCalled();
        expect(store.update).not.toHaveBeenCalled();
    });

    it('records an error per file without aborting the run', async () => {
        writeSkillFile(tmpDir, 'good',
            '---\nname: good\ndescription: d\n---\nbody');
        writeSkillFile(tmpDir, 'boom',
            '---\nname: boom\ndescription: d\n---\nbody');

        const store = makeStoreStub();
        store.create.mockImplementation(async (input: { name: string }) => {
            if (input.name === 'boom') throw new Error('nope');
            return makeSkill({ name: input.name });
        });

        const importer = new SkillImporter(store as unknown as ConstructorParameters<typeof SkillImporter>[0]);
        const result = await importer.importFromClaudeDir(tmpDir);

        expect(result.imported).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('boom');
    });

    it('counts malformed SKILL.md files as skipped', async () => {
        writeSkillFile(tmpDir, 'busted', 'no frontmatter here');
        const store = makeStoreStub();
        const importer = new SkillImporter(store as unknown as ConstructorParameters<typeof SkillImporter>[0]);

        const result = await importer.importFromClaudeDir(tmpDir);
        expect(result.skipped).toBe(1);
        expect(result.imported).toBe(0);
        expect(store.create).not.toHaveBeenCalled();
    });

    it('picks up a SKILL.md at the root as well as sub-folders', async () => {
        fs.writeFileSync(
            path.join(tmpDir, 'SKILL.md'),
            '---\nname: root-skill\ndescription: r\n---\nbody',
            'utf-8'
        );
        writeSkillFile(tmpDir, 'nested',
            '---\nname: nested-skill\ndescription: n\n---\nbody');

        const store = makeStoreStub();
        const importer = new SkillImporter(store as unknown as ConstructorParameters<typeof SkillImporter>[0]);
        const result = await importer.importFromClaudeDir(tmpDir);
        expect(result.imported).toBe(2);
    });
});
