/**
 * Scout + webResearch wiring (Phase 2 loop-B)
 *
 * Verifies that Scout automatically pulls web context when the task
 * description contains URLs, prepends a "## Web context" block to the AI
 * prompt, and survives individual fetch failures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before Scout import) ─────────────

vi.mock('../../../src/db/client', () => ({
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    getOne: vi.fn(async () => null),
    getMany: vi.fn(async () => []),
}));

const { mockSendPrompt } = vi.hoisted(() => ({
    mockSendPrompt: vi.fn(async () => ({
        text: '# Response',
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0.0001,
        model: 'test-model',
        durationMs: 42,
    })),
}));

vi.mock('../../../src/agents/ai-adapter', () => ({
    sendPrompt: mockSendPrompt,
}));

vi.mock('fs', () => ({
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => ''),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
}));

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

vi.mock('../../../src/orchestrator/event-bus', () => ({
    EventBus: vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        publish: vi.fn(async () => undefined),
        subscribe: vi.fn(async () => undefined),
        subscribeAll: vi.fn(),
        disconnect: vi.fn(async () => undefined),
    })),
}));

// ── Import after mocks ───────────────────────────────

import { Scout } from '../../../src/agents/specialists/scout';
import type { TaskInfo } from '../../../src/agents/autonaut-agent';

// ── Helpers ──────────────────────────────────────────

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Research Task',
        description: 'Do some research.',
        taskType: 'market-research',
        phase: 'discovery',
        outputPath: null,
        repoPath: '/tmp/test-repo',
        ...overrides,
    };
}

function makeScrapeResult(url: string, markdown: string) {
    return {
        url,
        markdown,
        html: `<p>${markdown}</p>`,
        links: [],
        metadata: {
            title: null,
            description: null,
            contentType: 'text/html',
            bytes: markdown.length,
            status: 200,
            finalUrl: url,
            truncated: false,
        },
        engine: 'fetch',
        cacheHit: false,
    };
}

// ── Tests ────────────────────────────────────────────

describe('Scout + webResearch', () => {
    let scout: Scout;
    let webResearchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        scout = new Scout({ model: 'test-model' });
        webResearchSpy = vi.spyOn(scout, 'webResearch');
    });

    it('does not call webResearch when description has no URLs', async () => {
        const task = createTask({
            description: 'Research our top three competitors in the analytics space.',
        });

        await scout.executeTask(task);

        expect(webResearchSpy).not.toHaveBeenCalled();
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        expect(userPrompt).not.toContain('## Web context');
        // Original prompt structure preserved.
        expect(userPrompt).toContain('market research');
    });

    it('fetches each URL and augments the prompt with both markdown blocks', async () => {
        webResearchSpy.mockImplementation(async (url: string) => {
            if (url === 'https://alpha.example.com') {
                return makeScrapeResult(url, 'Alpha page content — detailed feature list.');
            }
            if (url === 'https://beta.example.com') {
                return makeScrapeResult(url, 'Beta page content — pricing tiers and plans.');
            }
            throw new Error(`unexpected url: ${url}`);
        });

        const task = createTask({
            description:
                'Compare https://alpha.example.com and https://beta.example.com for pricing.',
        });

        await scout.executeTask(task);

        expect(webResearchSpy).toHaveBeenCalledTimes(2);
        expect(webResearchSpy).toHaveBeenCalledWith(
            'https://alpha.example.com',
            expect.objectContaining({ scrape: expect.objectContaining({ timeoutMs: 15000 }) }),
        );
        expect(webResearchSpy).toHaveBeenCalledWith(
            'https://beta.example.com',
            expect.objectContaining({ scrape: expect.objectContaining({ timeoutMs: 15000 }) }),
        );

        expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        expect(userPrompt).toContain('## Web context');
        expect(userPrompt).toContain('### https://alpha.example.com');
        expect(userPrompt).toContain('Alpha page content');
        expect(userPrompt).toContain('### https://beta.example.com');
        expect(userPrompt).toContain('Beta page content');
        // Web context must come before the original task prompt body.
        expect(userPrompt.indexOf('## Web context')).toBeLessThan(userPrompt.indexOf('market research'));
    });

    it('still completes when one URL fails — surviving URL content is included', async () => {
        webResearchSpy.mockImplementation(async (url: string) => {
            if (url === 'https://good.example.com') {
                return makeScrapeResult(url, 'Good content survived.');
            }
            if (url === 'https://bad.example.com') {
                throw new Error('connection refused');
            }
            throw new Error(`unexpected url: ${url}`);
        });

        const task = createTask({
            description:
                'Check https://good.example.com and also https://bad.example.com before writing.',
        });

        await expect(scout.executeTask(task)).resolves.toBeUndefined();

        expect(webResearchSpy).toHaveBeenCalledTimes(2);
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);

        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        expect(userPrompt).toContain('## Web context');
        expect(userPrompt).toContain('### https://good.example.com');
        expect(userPrompt).toContain('Good content survived');
        // The failed URL should not appear as a heading in web context.
        expect(userPrompt).not.toContain('### https://bad.example.com');
    });

    it('caps URLs at 5 per task', async () => {
        webResearchSpy.mockImplementation(async (url: string) =>
            makeScrapeResult(url, 'content'),
        );

        const urls = Array.from({ length: 7 }, (_, i) => `https://example${i}.com`);
        const task = createTask({
            description: `Research these: ${urls.join(' , ')}`,
        });

        await scout.executeTask(task);

        expect(webResearchSpy).toHaveBeenCalledTimes(5);
    });

    it('truncates per-URL markdown to 3000 chars in the augmented prompt', async () => {
        const longMarkdown = 'X'.repeat(5000);
        webResearchSpy.mockResolvedValue(
            makeScrapeResult('https://example.com', longMarkdown),
        );

        const task = createTask({
            description: 'See https://example.com for details.',
        });

        await scout.executeTask(task);

        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        // Count X's in the web-context section — must be <= 3000.
        const xCount = (userPrompt.match(/X/g) ?? []).length;
        expect(xCount).toBeLessThanOrEqual(3000);
        expect(xCount).toBeGreaterThan(0);
    });

    it('omits web-context section entirely when every fetch fails', async () => {
        webResearchSpy.mockRejectedValue(new Error('DB not ready'));

        const task = createTask({
            description: 'Check https://a.example.com and https://b.example.com.',
        });

        await expect(scout.executeTask(task)).resolves.toBeUndefined();

        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        expect(userPrompt).not.toContain('## Web context');
    });
});
