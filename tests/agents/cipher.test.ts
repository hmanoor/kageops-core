/**
 * Cipher agent behavioral tests
 *
 * Tests Cipher's executeTask dispatch, output paths,
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
        // Valid shape for both Markdown (leading `#`/`-`) AND .sql
        // (CREATE keyword) so the 2026-06 narration-leak funnel guard
        // accepts the write regardless of the routed output extension.
        text: '-- Mock Data Model\nCREATE TABLE example (id INT);\n\n# Schema\n\nGenerated schema.',
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

import { Cipher } from '../../src/agents/specialists/cipher';
import type { TaskInfo } from '../../src/agents/autonaut-agent';

// ── Test Setup ──────────────────────────────────────

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Test Data Task',
        description: 'Design a schema for user analytics.',
        taskType: 'data-model',
        phase: 'development',
        outputPath: null,
        repoPath: '/tmp/test-repo',
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────

describe('Cipher agent', () => {
    let cipher: Cipher;

    beforeEach(() => {
        vi.clearAllMocks();
        cipher = new Cipher({ model: 'claude/claude-sonnet-4-20250514' });
    });

    describe('instantiation', () => {
        it('has correct name and role', () => {
            expect(cipher.name).toBe('cipher');
            expect(cipher.role).toBe('data-specialist');
        });

        it('has expected skills', () => {
            expect(cipher.skills).toContain('data-pipeline');
            expect(cipher.skills).toContain('sql');
            expect(cipher.skills).toContain('data-modeling');
            expect(cipher.skills).toContain('machine-learning');
            expect(cipher.skills.length).toBeGreaterThan(5);
        });

        it('starts idle with no current task', () => {
            expect(cipher.status).toBe('idle');
            expect(cipher.currentTask).toBeNull();
        });
    });

    describe('executeTask() dispatch', () => {
        it('handles data-model task type', async () => {
            const task = createTask({ taskType: 'data-model' });
            await cipher.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('data model');
        });

        it('handles data-pipeline task type', async () => {
            const task = createTask({ taskType: 'data-pipeline' });
            await cipher.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('data pipeline');
        });

        it('handles sql-query task type', async () => {
            const task = createTask({ taskType: 'sql-query' });
            await cipher.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('SQL');
        });

        it('handles analytics task type', async () => {
            const task = createTask({ taskType: 'analytics' });
            await cipher.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('analytics');
        });

        it('handles data-quality task type', async () => {
            const task = createTask({ taskType: 'data-quality' });
            await cipher.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('data quality');
        });

        it('handles schema-migration task type', async () => {
            const task = createTask({ taskType: 'schema-migration' });
            await cipher.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('migration');
        });

        it('handles ml-pipeline task type', async () => {
            const task = createTask({ taskType: 'ml-pipeline' });
            await cipher.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('ML pipeline');
        });

        it('falls back to generic handler for unknown task type', async () => {
            const task = createTask({ taskType: 'unknown-type' });
            await cipher.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('Complete the following data task');
        });
    });

    describe('output file paths', () => {
        it('writes data-model to default path', async () => {
            const task = createTask({ taskType: 'data-model', outputPath: null });
            await cipher.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('data-model.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('writes data-pipeline to default path', async () => {
            const task = createTask({ taskType: 'data-pipeline', outputPath: null });
            await cipher.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('pipeline.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('writes sql-query to .sql file by default', async () => {
            const task = createTask({ taskType: 'sql-query', outputPath: null });
            await cipher.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('sql-queries.sql'),
                expect.any(String),
                'utf-8'
            );
        });

        it('uses custom outputPath when provided', async () => {
            const task = createTask({ taskType: 'data-model', outputPath: 'custom/schema.md' });
            await cipher.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('schema.md'),
                expect.any(String),
                'utf-8'
            );
        });
    });

    describe('AI interaction', () => {
        it('includes task title and description in prompt', async () => {
            const task = createTask({
                title: 'User Events Schema',
                description: 'Model user event tracking.',
            });
            await cipher.executeTask(task);

            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('User Events Schema');
            expect(userPrompt).toContain('Model user event tracking.');
        });

        it('writes AI response text to file', async () => {
            await cipher.executeTask(createTask());

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.any(String),
                '-- Mock Data Model\nCREATE TABLE example (id INT);\n\n# Schema\n\nGenerated schema.',
                'utf-8'
            );
        });
    });
});
