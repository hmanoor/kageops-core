/**
 * Skill hooks unit tests.
 *
 * Covers:
 *   - augmentSystemPrompt: 0 / 1 / 3 / 10 matches, truncation, ordering.
 *   - captureCandidateSkill: heuristic trigger, no-op miss, swallows errors.
 *   - askAI integration: env flag on vs off, with mocked registry + store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────

vi.mock('../../src/db/client', () => ({
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    getOne: vi.fn(async () => null),
    getMany: vi.fn(async () => []),
    initDatabase: vi.fn(async () => undefined),
    closePool: vi.fn(async () => undefined),
}));

vi.mock('../../src/agents/ai-adapter', () => ({
    sendPrompt: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────

import {
    augmentSystemPrompt,
    captureCandidateSkill,
    shouldCapture,
    loadTriggersFromEnv,
    SkillCaptureTask,
} from '../../src/agents/skill-hooks';
import type { SkillRegistry } from '../../src/skills/skill-registry';
import type { SkillStore } from '../../src/skills/skill-store';
import type { Skill, SkillSearchResult } from '../../src/skills/types';
import { AutonautAgent, TaskInfo, AgentModelConfig } from '../../src/agents/autonaut-agent';
import { EventBus } from '../../src/orchestrator/event-bus';
import { sendPrompt } from '../../src/agents/ai-adapter';
import { query } from '../../src/db/client';

const mockSendPrompt = vi.mocked(sendPrompt);
const mockQuery = vi.mocked(query);

// ── Fixtures ──────────────────────────────────────────

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    const base: Skill = {
        id: 'skill-' + (overrides.name ?? 'x'),
        name: 'sample-skill',
        description: 'A sample skill for testing.',
        body: 'This is the body of the skill — it explains how to do the thing.',
        tags: ['sample'],
        source: 'imported',
        parentSkillIds: [],
        version: 1,
        usageCount: 0,
        embedding: null,
        createdAt: '2026-04-21T00:00:00Z',
        updatedAt: '2026-04-21T00:00:00Z',
        ...overrides,
    };
    return Object.freeze(base);
}

function makeResult(score: number, overrides: Partial<Skill> = {}): SkillSearchResult {
    return Object.freeze({ skill: makeSkill(overrides), score });
}

function makeCaptureTask(overrides: Partial<SkillCaptureTask> = {}): SkillCaptureTask {
    return {
        id: 'task-abc-12345678',
        title: 'Capture this task',
        description: 'Some description',
        taskType: 'build',
        ...overrides,
    };
}

function makeRegistry(results: readonly SkillSearchResult[] | Error): SkillRegistry {
    return {
        search: vi.fn(async () => {
            if (results instanceof Error) throw results;
            return results;
        }),
        pin: vi.fn(async () => undefined),
        unpin: vi.fn(async () => undefined),
    } as unknown as SkillRegistry;
}

function makeStore(overrides: Partial<SkillStore> = {}): SkillStore {
    const defaultSkill = makeSkill({ id: 'new-skill-id', name: 'created' });
    return {
        getByName: vi.fn(async () => null),
        create: vi.fn(async () => defaultSkill),
        recordEvolution: vi.fn(async () => ({
            id: 'evo-1',
            skillId: defaultSkill.id,
            evolutionType: 'captured',
            triggerTaskId: null,
            notes: '',
            createdAt: '2026-04-21T00:00:00Z',
        })),
        getById: vi.fn(async () => null),
        list: vi.fn(async () => []),
        update: vi.fn(async () => null),
        delete: vi.fn(async () => false),
        getEvolutions: vi.fn(async () => []),
        incrementUsage: vi.fn(async () => undefined),
        ...overrides,
    } as unknown as SkillStore;
}

// ── augmentSystemPrompt ───────────────────────────────

describe('augmentSystemPrompt()', () => {
    it('returns prompt unchanged when registry returns 0 hits', async () => {
        const registry = makeRegistry([]);
        const { prompt, hits } = await augmentSystemPrompt(
            'BASE',
            'find me retry guidance',
            registry
        );
        expect(prompt).toBe('BASE');
        expect(hits).toEqual([]);
    });

    it('returns prompt unchanged and empty hits when registry throws', async () => {
        const registry = makeRegistry(new Error('boom'));
        const { prompt, hits } = await augmentSystemPrompt('BASE', 'query', registry);
        expect(prompt).toBe('BASE');
        expect(hits).toEqual([]);
    });

    it('injects a single skill with description and body', async () => {
        const registry = makeRegistry([
            makeResult(0.9, { name: 'retry-with-backoff', description: 'Exponential backoff.', body: 'Body text.' }),
        ]);
        const { prompt, hits } = await augmentSystemPrompt('BASE', 'retry', registry);
        expect(hits).toHaveLength(1);
        expect(prompt).toContain('BASE');
        expect(prompt).toContain('## Relevant skills from the library');
        expect(prompt).toContain('### retry-with-backoff');
        expect(prompt).toContain('Exponential backoff.');
        expect(prompt).toContain('Body text.');
    });

    it('injects up to 3 skills by default, preserving order (highest score first)', async () => {
        // Registry already returns sorted by score DESC; we should not reorder.
        const registry = makeRegistry([
            makeResult(0.9, { id: 's1', name: 'alpha' }),
            makeResult(0.6, { id: 's2', name: 'beta' }),
            makeResult(0.3, { id: 's3', name: 'gamma' }),
        ]);
        const { prompt, hits } = await augmentSystemPrompt('BASE', 'anything', registry);
        expect(hits.map((h) => h.skill.name)).toEqual(['alpha', 'beta', 'gamma']);
        const alphaIdx = prompt.indexOf('### alpha');
        const betaIdx = prompt.indexOf('### beta');
        const gammaIdx = prompt.indexOf('### gamma');
        expect(alphaIdx).toBeGreaterThan(-1);
        expect(betaIdx).toBeGreaterThan(alphaIdx);
        expect(gammaIdx).toBeGreaterThan(betaIdx);
    });

    it('caps at 3 even when 10 matches are available', async () => {
        const results: SkillSearchResult[] = [];
        for (let i = 0; i < 10; i += 1) {
            results.push(makeResult(1 - i * 0.05, { id: `s${i}`, name: `skill-${i}` }));
        }
        const registry = makeRegistry(results);
        // Registry itself would cap at `limit` — simulate by slicing in the mock:
        (registry.search as ReturnType<typeof vi.fn>).mockImplementationOnce(
            async (_q: string, opts?: { limit?: number }) => {
                const lim = opts?.limit ?? 10;
                return results.slice(0, lim);
            }
        );
        const { prompt, hits } = await augmentSystemPrompt('BASE', 'q', registry);
        expect(hits).toHaveLength(3);
        expect(prompt).toContain('### skill-0');
        expect(prompt).toContain('### skill-1');
        expect(prompt).toContain('### skill-2');
        expect(prompt).not.toContain('### skill-3');
    });

    it('truncates skill bodies longer than 500 chars', async () => {
        const longBody = 'x'.repeat(1200);
        const registry = makeRegistry([
            makeResult(0.5, { name: 'huge', body: longBody }),
        ]);
        const { prompt } = await augmentSystemPrompt('BASE', 'q', registry);
        // The full 1200 chars must not appear verbatim.
        expect(prompt).not.toContain('x'.repeat(1200));
        expect(prompt).toContain('x'.repeat(500));
        expect(prompt).toContain('(truncated)');
    });

    it('passes userPrompt to registry.search with limit=3', async () => {
        const registry = makeRegistry([]);
        await augmentSystemPrompt('BASE', 'my user query', registry);
        expect(registry.search).toHaveBeenCalledWith('my user query', { limit: 3 });
    });
});

// ── shouldCapture / loadTriggersFromEnv ───────────────

describe('shouldCapture()', () => {
    const DEFAULT_TRIGGERS = ['how to', 'learn from this'] as const;

    it('returns true when description contains a trigger (case-insensitive)', () => {
        const task = makeCaptureTask({ description: 'Please learn from THIS build' });
        expect(shouldCapture('short', task, DEFAULT_TRIGGERS)).toBe(true);
    });

    it('returns true when response is > 2000 chars AND contains a code fence', () => {
        const task = makeCaptureTask({ description: 'neutral description' });
        const longCode = `# heading\n\n\`\`\`ts\nexport const x = 1;\n\`\`\`\n${'filler '.repeat(400)}`;
        expect(shouldCapture(longCode, task, DEFAULT_TRIGGERS)).toBe(true);
    });

    it('returns false when response is long but has no code fence', () => {
        const task = makeCaptureTask({ description: 'plain request' });
        const longProse = 'a'.repeat(3000);
        expect(shouldCapture(longProse, task, DEFAULT_TRIGGERS)).toBe(false);
    });

    it('returns false when response has code but is short', () => {
        const task = makeCaptureTask({ description: 'plain request' });
        const shortCode = '```js\nconst x = 1;\n```';
        expect(shouldCapture(shortCode, task, DEFAULT_TRIGGERS)).toBe(false);
    });

    it('respects custom trigger list', () => {
        const task = makeCaptureTask({ description: 'memo: capture this pattern' });
        expect(shouldCapture('short', task, ['capture this'])).toBe(true);
        expect(shouldCapture('short', task, ['completely different'])).toBe(false);
    });
});

describe('loadTriggersFromEnv()', () => {
    const ORIGINAL = process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'];

    afterEach(() => {
        if (ORIGINAL === undefined) {
            delete process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'];
        } else {
            process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'] = ORIGINAL;
        }
    });

    it('returns defaults when env var unset', () => {
        delete process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'];
        expect(loadTriggersFromEnv()).toEqual(['how to', 'learn from this']);
    });

    it('returns defaults when env var blank', () => {
        process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'] = '   ';
        expect(loadTriggersFromEnv()).toEqual(['how to', 'learn from this']);
    });

    it('splits, trims, and lowercases a comma-separated list', () => {
        process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'] = ' Teach Me , capture this ,,  ';
        expect(loadTriggersFromEnv()).toEqual(['teach me', 'capture this']);
    });
});

// ── captureCandidateSkill ─────────────────────────────

describe('captureCandidateSkill()', () => {
    it('creates a skill when heuristic matches via trigger phrase', async () => {
        const store = makeStore();
        const task = makeCaptureTask({ description: 'document how to retry requests' });
        const skill = await captureCandidateSkill('short response', task, store);
        expect(skill).not.toBeNull();
        expect(store.create).toHaveBeenCalledTimes(1);
        const createArg = (store.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(createArg.source).toBe('captured');
        expect(createArg.tags).toContain('captured');
        expect(createArg.tags).toContain('build');
        // Name should be a slugified derivation of the title with task-id suffix.
        expect(createArg.name).toContain('capture-this-task');
    });

    it('creates a skill for long code responses even without trigger', async () => {
        const store = makeStore();
        const task = makeCaptureTask({ description: 'plain task description' });
        const longCode = `explanation\n\`\`\`ts\nfn();\n\`\`\`\n${'filler '.repeat(400)}`;
        const skill = await captureCandidateSkill(longCode, task, store);
        expect(skill).not.toBeNull();
        expect(store.create).toHaveBeenCalled();
    });

    it('no-ops when heuristic does not match', async () => {
        const store = makeStore();
        const task = makeCaptureTask({ description: 'plain task' });
        const skill = await captureCandidateSkill('short reply', task, store);
        expect(skill).toBeNull();
        expect(store.create).not.toHaveBeenCalled();
    });

    it('skips when a skill with the generated name already exists', async () => {
        const existing = makeSkill({ name: 'existing' });
        const store = makeStore({
            getByName: vi.fn(async () => existing) as unknown as SkillStore['getByName'],
        });
        const task = makeCaptureTask({ description: 'how to do X' });
        const skill = await captureCandidateSkill('short', task, store);
        expect(skill).toBeNull();
        expect(store.create).not.toHaveBeenCalled();
    });

    it('swallows store.create errors without throwing', async () => {
        const store = makeStore({
            create: vi.fn(async () => { throw new Error('db down'); }) as unknown as SkillStore['create'],
        });
        const task = makeCaptureTask({ description: 'how to capture' });
        await expect(
            captureCandidateSkill('short', task, store)
        ).resolves.toBeNull();
    });

    it('swallows store.recordEvolution errors (capture still succeeds)', async () => {
        const created = makeSkill({ id: 'new-id', name: 'captured-name' });
        const store = makeStore({
            create: vi.fn(async () => created) as unknown as SkillStore['create'],
            recordEvolution: vi.fn(async () => { throw new Error('evo down'); }) as unknown as SkillStore['recordEvolution'],
        });
        const task = makeCaptureTask({ description: 'how to recover' });
        const skill = await captureCandidateSkill('short', task, store);
        expect(skill).toEqual(created);
    });

    it('honours custom triggers via opts', async () => {
        const store = makeStore();
        const task = makeCaptureTask({ description: 'remember this cookbook' });
        const skill = await captureCandidateSkill('short', task, store, { triggers: ['cookbook'] });
        expect(skill).not.toBeNull();
    });
});

// ── askAI end-to-end integration ──────────────────────

const MODEL_CONFIG: AgentModelConfig = {
    model: 'claude/claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
};

class TestAgent extends AutonautAgent {
    constructor() {
        super('test-agent', 'tester', ['testing'] as const, MODEL_CONFIG, 'BASE SYSTEM');
    }
    async executeTask(): Promise<void> { /* no-op for these tests */ }
    public testAskAI(prompt: string): Promise<import('../../src/agents/ai-adapter').AiResponse> {
        return this.askAI(prompt);
    }
    public setCurrentTaskForTest(task: TaskInfo): void {
        (this as unknown as { _currentTask: TaskInfo | null })._currentTask = task;
    }
}

function makeMockEventBus(): EventBus {
    return {
        subscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        subscribeAll: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as EventBus;
}

function makeTaskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Do the thing',
        description: 'Please explain how to do the thing',
        taskType: 'research',
        phase: 'discovery',
        outputPath: null,
        repoPath: '/tmp/repo',
        ...overrides,
    };
}

describe('AutonautAgent.askAI — skill hook integration', () => {
    const ORIG_FLAG = process.env['KAGEOPS_SKILLS_HOOKS'];

    beforeEach(() => {
        vi.clearAllMocks();
        mockSendPrompt.mockResolvedValue({
            text: 'ok',
            tokensIn: 1,
            tokensOut: 1,
            costUsd: 0,
            model: MODEL_CONFIG.model,
            durationMs: 1,
        });
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    });

    afterEach(() => {
        if (ORIG_FLAG === undefined) delete process.env['KAGEOPS_SKILLS_HOOKS'];
        else process.env['KAGEOPS_SKILLS_HOOKS'] = ORIG_FLAG;
    });

    it('does NOT call registry.search when flag is off (default behaviour)', async () => {
        delete process.env['KAGEOPS_SKILLS_HOOKS'];
        const agent = new TestAgent();
        const registry = makeRegistry([makeResult(0.9, { name: 'should-not-inject' })]);
        const store = makeStore();
        agent.setSkillInfra(registry, store);

        await agent.connect(makeMockEventBus());
        await agent.testAskAI('a prompt');

        expect(registry.search).not.toHaveBeenCalled();
        // sendPrompt received UNaugmented system prompt.
        const sendArgs = mockSendPrompt.mock.calls[0];
        expect(sendArgs[1]).not.toContain('Relevant skills from the library');
    });

    it('augments the system prompt when flag is on and registry has hits', async () => {
        process.env['KAGEOPS_SKILLS_HOOKS'] = 'true';
        const agent = new TestAgent();
        const registry = makeRegistry([
            makeResult(0.9, { name: 'retry-with-backoff', description: 'desc', body: 'body content' }),
        ]);
        const store = makeStore();
        agent.setSkillInfra(registry, store);

        await agent.connect(makeMockEventBus());
        await agent.testAskAI('a prompt about retries');

        expect(registry.search).toHaveBeenCalledWith('a prompt about retries', { limit: 3 });
        const sendArgs = mockSendPrompt.mock.calls[0];
        const sentSystem = sendArgs[1] as string;
        expect(sentSystem).toContain('## Relevant skills from the library');
        expect(sentSystem).toContain('### retry-with-backoff');
        expect(sentSystem).toContain('body content');
    });

    it('does not augment when flag is on but no registry is wired', async () => {
        process.env['KAGEOPS_SKILLS_HOOKS'] = 'true';
        const agent = new TestAgent();
        // No setSkillInfra call.

        await agent.connect(makeMockEventBus());
        await agent.testAskAI('a prompt');

        const sendArgs = mockSendPrompt.mock.calls[0];
        expect(sendArgs[1]).not.toContain('Relevant skills');
    });

    it('fires capture in background when flag is on (does not block)', async () => {
        process.env['KAGEOPS_SKILLS_HOOKS'] = 'true';
        process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'] = 'how to';
        const agent = new TestAgent();
        const registry = makeRegistry([]);
        const store = makeStore();
        agent.setSkillInfra(registry, store);

        await agent.connect(makeMockEventBus());
        // Seed a current task so maybeCaptureSkill has something to capture for.
        agent.setCurrentTaskForTest(makeTaskInfo({ description: 'learn how to retry' }));

        mockSendPrompt.mockResolvedValueOnce({
            text: 'a helpful answer',
            tokensIn: 1, tokensOut: 1, costUsd: 0,
            model: MODEL_CONFIG.model, durationMs: 1,
        });

        await agent.testAskAI('prompt');

        // Capture is detached; wait a macrotask for it to settle.
        await new Promise((r) => setTimeout(r, 20));

        expect(store.getByName).toHaveBeenCalled();
        expect(store.create).toHaveBeenCalled();
        delete process.env['KAGEOPS_SKILL_CAPTURE_TRIGGERS'];
    });

    it('does NOT fire capture when flag is off', async () => {
        delete process.env['KAGEOPS_SKILLS_HOOKS'];
        const agent = new TestAgent();
        const registry = makeRegistry([]);
        const store = makeStore();
        agent.setSkillInfra(registry, store);

        await agent.connect(makeMockEventBus());
        agent.setCurrentTaskForTest(makeTaskInfo({ description: 'how to capture' }));
        await agent.testAskAI('prompt');
        await new Promise((r) => setTimeout(r, 20));

        expect(store.create).not.toHaveBeenCalled();
    });
});
