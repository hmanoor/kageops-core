/**
 * Scout agent behavioral tests
 *
 * Tests Scout's executeTask dispatch, output paths,
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
        text: '# Mock AI Response\n\nGenerated content.',
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

// ── Mock fs (for writeFile in base class) ───────────

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

// ── Import after mocks ─────────────────────────────

import { Scout } from '../../src/agents/specialists/scout';
import type { TaskInfo } from '../../src/agents/autonaut-agent';

// ── Test Setup ──────────────────────────────────────

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Test Task',
        description: 'A test description for the task.',
        taskType: 'concept-brief',
        phase: 'discovery',
        outputPath: null,
        repoPath: '/tmp/test-repo',
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────

describe('Scout agent', () => {
    let scout: Scout;

    beforeEach(() => {
        vi.clearAllMocks();
        scout = new Scout({ model: 'claude/claude-sonnet-4-20250514' });
    });

    describe('instantiation', () => {
        it('has correct name and role', () => {
            expect(scout.name).toBe('scout');
            expect(scout.role).toBe('strategist');
        });

        it('has expected skills', () => {
            expect(scout.skills).toContain('market-research');
            expect(scout.skills).toContain('prd-writing');
            expect(scout.skills).toContain('competitive-analysis');
            expect(scout.skills.length).toBeGreaterThan(5);
        });

        it('starts idle with no current task', () => {
            expect(scout.status).toBe('idle');
            expect(scout.currentTask).toBeNull();
        });
    });

    describe('executeTask() dispatch', () => {
        it('handles concept-brief task type', async () => {
            const task = createTask({ taskType: 'concept-brief' });
            await scout.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, systemPrompt, userPrompt] = mockSendPrompt.mock.calls[0];
            expect(systemPrompt).toContain('Scout');
            expect(userPrompt).toContain('concept brief');
        });

        it('handles market-research task type', async () => {
            const task = createTask({ taskType: 'market-research' });
            await scout.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('market research');
        });

        it('handles feasibility-assessment task type', async () => {
            const task = createTask({ taskType: 'feasibility-assessment' });
            await scout.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('feasibility');
        });

        it('handles prd task type', async () => {
            const task = createTask({ taskType: 'prd' });
            await scout.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('Product Requirements Document');
        });

        it('handles project-plan task type', async () => {
            const task = createTask({ taskType: 'project-plan' });
            await scout.executeTask(task);
            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        });

        it('handles competitive-analysis task type', async () => {
            const task = createTask({ taskType: 'competitive-analysis' });
            await scout.executeTask(task);
            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        });

        it('handles risk-assessment task type', async () => {
            const task = createTask({ taskType: 'risk-assessment' });
            await scout.executeTask(task);
            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        });

        it('falls back to generic handler for unknown task type', async () => {
            const task = createTask({ taskType: 'unknown-type' });
            await scout.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('Complete the following task');
        });
    });

    describe('output file paths', () => {
        it('writes concept-brief to default path when outputPath is null', async () => {
            const task = createTask({ taskType: 'concept-brief', outputPath: null });
            await scout.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('concept-brief.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('uses custom outputPath when provided', async () => {
            const task = createTask({
                taskType: 'concept-brief',
                outputPath: 'custom/output/brief.md',
            });
            await scout.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('brief.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('writes market-research to discovery directory by default', async () => {
            const task = createTask({ taskType: 'market-research', outputPath: null });
            await scout.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('market-research.md'),
                expect.any(String),
                'utf-8'
            );
        });
    });

    describe('AI interaction', () => {
        it('passes task title and description to AI prompt', async () => {
            const task = createTask({
                taskType: 'concept-brief',
                title: 'My Cool Project',
                description: 'Build an amazing app',
            });
            await scout.executeTask(task);

            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('My Cool Project');
            expect(userPrompt).toContain('Build an amazing app');
        });

        it('writes AI response text to output file with appended cost estimate', async () => {
            mockSendPrompt.mockResolvedValueOnce({
                text: '# Generated Brief\n\nContent here.',
                tokensIn: 100,
                tokensOut: 200,
                costUsd: 0.001,
                model: 'claude/claude-sonnet-4-20250514',
                durationMs: 500,
            });

            const task = createTask({ taskType: 'concept-brief' });
            await scout.executeTask(task);

            // The brief now ends with a forward-looking "## Cost Estimate"
            // section sourced from the cost-estimator module. We assert on
            // the leading body (so this test stays focused on Scout's wiring,
            // not the estimator's exact disclaimer copy — that's pinned in
            // tests/orchestrator/cost-estimator.test.ts).
            expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
            const writtenBody = mockWriteFileSync.mock.calls[0]?.[1] as string;
            expect(writtenBody).toContain('# Generated Brief\n\nContent here.');
            expect(writtenBody).toContain('## Cost Estimate');
            expect(writtenBody).toContain('Estimate only — not a quote');
        });
    });
});
