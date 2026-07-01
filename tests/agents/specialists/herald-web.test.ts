/**
 * Herald + webResearch wiring (Phase 2 loop-B)
 *
 * Verifies that Herald automatically pulls web context when the task
 * description contains URLs, prepends a "## Web context" block to the AI
 * prompt, and survives individual fetch failures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before Herald import) ────────────

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

vi.mock('../../../src/main/secret-store', () => ({
    getApiKey: vi.fn(async () => null),
}));

// ── Import after mocks ───────────────────────────────

import { Herald } from '../../../src/agents/specialists/herald';
import type { TaskInfo } from '../../../src/agents/autonaut-agent';

// ── Helpers ──────────────────────────────────────────

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Marketing Task',
        description: 'Prepare go-to-market materials.',
        taskType: 'go-to-market-strategy',
        phase: 'business-viability',
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

describe('Herald + webResearch', () => {
    let herald: Herald;
    let webResearchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        herald = new Herald({ model: 'test-model' });
        webResearchSpy = vi.spyOn(herald, 'webResearch');
    });

    it('does not call webResearch when description has no URLs', async () => {
        const task = createTask({
            description: 'Draft a GTM plan for our new analytics product.',
        });

        await herald.executeTask(task);

        expect(webResearchSpy).not.toHaveBeenCalled();
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        expect(userPrompt).not.toContain('## Web context');
        expect(userPrompt).toContain('go-to-market strategy');
    });

    it('fetches each URL and augments the prompt with both markdown blocks', async () => {
        webResearchSpy.mockImplementation(async (url: string) => {
            if (url === 'https://alpha.example.com') {
                return makeScrapeResult(url, 'Alpha brand voice guide and messaging matrix.');
            }
            if (url === 'https://beta.example.com') {
                return makeScrapeResult(url, 'Beta competitor pricing and positioning.');
            }
            throw new Error(`unexpected url: ${url}`);
        });

        const task = createTask({
            description:
                'Benchmark against https://alpha.example.com and https://beta.example.com for launch copy.',
        });

        await herald.executeTask(task);

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
        expect(userPrompt).toContain('Alpha brand voice guide');
        expect(userPrompt).toContain('### https://beta.example.com');
        expect(userPrompt).toContain('Beta competitor pricing');
        expect(userPrompt.indexOf('## Web context')).toBeLessThan(
            userPrompt.indexOf('go-to-market strategy'),
        );
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
                'Reference https://good.example.com and https://bad.example.com for the campaign.',
        });

        await expect(herald.executeTask(task)).resolves.toBeUndefined();

        expect(webResearchSpy).toHaveBeenCalledTimes(2);
        expect(mockSendPrompt).toHaveBeenCalledTimes(1);

        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        expect(userPrompt).toContain('## Web context');
        expect(userPrompt).toContain('### https://good.example.com');
        expect(userPrompt).toContain('Good content survived');
        expect(userPrompt).not.toContain('### https://bad.example.com');
    });

    it('caps URLs at 5 per task', async () => {
        webResearchSpy.mockImplementation(async (url: string) =>
            makeScrapeResult(url, 'content'),
        );

        const urls = Array.from({ length: 7 }, (_, i) => `https://example${i}.com`);
        const task = createTask({
            description: `Sources: ${urls.join(' , ')}`,
        });

        await herald.executeTask(task);

        expect(webResearchSpy).toHaveBeenCalledTimes(5);
    });

    it('truncates per-URL markdown to 3000 chars in the augmented prompt', async () => {
        const longMarkdown = 'Y'.repeat(5000);
        webResearchSpy.mockResolvedValue(
            makeScrapeResult('https://example.com', longMarkdown),
        );

        const task = createTask({
            description: 'Review https://example.com before drafting.',
        });

        await herald.executeTask(task);

        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        const yCount = (userPrompt.match(/Y/g) ?? []).length;
        expect(yCount).toBeLessThanOrEqual(3000);
        expect(yCount).toBeGreaterThan(0);
    });

    it('omits web-context section entirely when every fetch fails', async () => {
        webResearchSpy.mockRejectedValue(new Error('DB not ready'));

        const task = createTask({
            description: 'Check https://a.example.com and https://b.example.com.',
        });

        await expect(herald.executeTask(task)).resolves.toBeUndefined();

        const userPrompt = mockSendPrompt.mock.calls[0][2] as string;
        expect(userPrompt).not.toContain('## Web context');
    });
});
