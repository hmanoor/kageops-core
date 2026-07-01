/**
 * Herald agent behavioral tests
 *
 * Tests Herald's executeTask dispatch, output paths,
 * and AI interaction without live AI or Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock db/client ──────────────────────────────────

vi.mock('../../src/db/client', () => ({
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    getOne: vi.fn(async () => null),
    getMany: vi.fn(async () => []),
}));

// ── Mock ai-adapter ────────────────────────────────

const { mockSendPrompt } = vi.hoisted(() => ({
    mockSendPrompt: vi.fn(async () => ({
        text: '# Mock GTM Strategy\n\nGenerated marketing content.',
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0.001,
        model: 'claude/claude-sonnet-4-20250514',
        durationMs: 500,
    })),
}));

vi.mock('../../src/agents/ai-adapter', () => ({
    sendPrompt: mockSendPrompt,
}));

// ── Mock fs ─────────────────────────────────────────

const { mockWriteFileSync, mockExistsSync, mockMkdirSync } = vi.hoisted(() => ({
    mockWriteFileSync: vi.fn(),
    mockExistsSync: vi.fn(() => true),
    mockMkdirSync: vi.fn(),
}));

vi.mock('fs', () => ({
    writeFileSync: mockWriteFileSync,
    readFileSync: vi.fn(() => 'file content'),
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    readdirSync: vi.fn(() => []),
}));

// ── Mock child_process ──────────────────────────────

vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

// ── Mock event-bus ──────────────────────────────────

const { mockPublish } = vi.hoisted(() => ({
    mockPublish: vi.fn(async () => undefined),
}));

vi.mock('../../src/orchestrator/event-bus', () => ({
    EventBus: vi.fn(() => ({
        connect: vi.fn(async () => undefined),
        publish: mockPublish,
        subscribe: vi.fn(async () => undefined),
        subscribeAll: vi.fn(),
        disconnect: vi.fn(async () => undefined),
    })),
}));

// ── Mock secret-store ───────────────────────────────

vi.mock('../../src/main/secret-store', () => ({
    getApiKey: vi.fn(async () => null),
}));

// ── Import after mocks ─────────────────────────────

import { Herald } from '../../src/agents/specialists/herald';
import type { TaskInfo } from '../../src/agents/autonaut-agent';

// ── Test Setup ──────────────────────────────────────

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Test Marketing Task',
        description: 'Create a go-to-market strategy for the SaaS product.',
        taskType: 'go-to-market-strategy',
        phase: 'business-viability',
        outputPath: null,
        repoPath: '/tmp/test-repo',
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────

describe('Herald agent', () => {
    let herald: Herald;

    beforeEach(() => {
        vi.clearAllMocks();
        herald = new Herald({ model: 'claude/claude-sonnet-4-20250514' });
    });

    describe('instantiation', () => {
        it('has correct name and role', () => {
            expect(herald.name).toBe('herald');
            expect(herald.role).toBe('marketer');
        });

        it('has expected skills', () => {
            expect(herald.skills).toContain('marketing-copy');
            expect(herald.skills).toContain('go-to-market');
            expect(herald.skills).toContain('product-messaging');
            expect(herald.skills).toContain('content-strategy');
            expect(herald.skills).toContain('social-media');
            expect(herald.skills).toContain('customer-research');
            expect(herald.skills).toContain('pricing-strategy');
            expect(herald.skills).toContain('retention-marketing');
            expect(herald.skills.length).toBe(8);
        });

        it('starts idle with no current task', () => {
            expect(herald.status).toBe('idle');
            expect(herald.currentTask).toBeNull();
        });
    });

    describe('executeTask() dispatch', () => {
        it('handles go-to-market-strategy task type', async () => {
            const task = createTask({ taskType: 'go-to-market-strategy' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('go-to-market strategy');
        });

        it('handles launch-messaging task type', async () => {
            const task = createTask({ taskType: 'launch-messaging' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('launch messaging');
        });

        it('handles product-copy task type', async () => {
            const task = createTask({ taskType: 'product-copy' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('product copy');
        });

        it('handles email-campaign task type', async () => {
            const task = createTask({ taskType: 'email-campaign' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('email campaign');
        });

        it('handles social-media-content task type', async () => {
            const task = createTask({ taskType: 'social-media-content' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('social media content');
        });

        it('handles pricing-strategy task type', async () => {
            const task = createTask({ taskType: 'pricing-strategy' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('pricing strategy');
        });

        it('handles customer-messaging task type', async () => {
            const task = createTask({ taskType: 'customer-messaging' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('customer messaging');
        });

        it('handles retention-strategy task type', async () => {
            const task = createTask({ taskType: 'retention-strategy' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('retention');
        });

        it('falls back to generic handler for unknown task type', async () => {
            const task = createTask({ taskType: 'unknown-type' });
            await herald.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('Complete the following marketing task');
        });
    });

    describe('output file paths', () => {
        it('writes go-to-market-strategy to default path', async () => {
            const task = createTask({ taskType: 'go-to-market-strategy', outputPath: null });
            await herald.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('go-to-market-strategy.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('writes launch-messaging to default path', async () => {
            const task = createTask({ taskType: 'launch-messaging', outputPath: null });
            await herald.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('launch-messaging.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('writes email-campaign to default path', async () => {
            const task = createTask({ taskType: 'email-campaign', outputPath: null });
            await herald.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('email-campaign.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('writes pricing-strategy to default path', async () => {
            const task = createTask({ taskType: 'pricing-strategy', outputPath: null });
            await herald.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('pricing-strategy.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('uses custom outputPath when provided', async () => {
            const task = createTask({ taskType: 'go-to-market-strategy', outputPath: 'custom/gtm.md' });
            await herald.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('gtm.md'),
                expect.any(String),
                'utf-8'
            );
        });
    });

    describe('AI interaction', () => {
        it('includes task title and description in prompt', async () => {
            const task = createTask({
                title: 'SaaS Launch Campaign',
                description: 'Launch campaign for a B2B analytics SaaS product.',
            });
            await herald.executeTask(task);

            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('SaaS Launch Campaign');
            expect(userPrompt).toContain('Launch campaign for a B2B analytics SaaS product.');
        });

        it('writes AI response text to file', async () => {
            await herald.executeTask(createTask());

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.any(String),
                '# Mock GTM Strategy\n\nGenerated marketing content.',
                'utf-8'
            );
        });
    });
});
