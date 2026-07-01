/**
 * Pixel agent behavioral tests
 *
 * Tests Pixel's executeTask dispatch, output paths,
 * and AI interaction without live AI or Postgres.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock db/client ──────────────────────────────────

const { mockDbQuery } = vi.hoisted(() => ({
    mockDbQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

vi.mock('../../src/db/client', () => ({
    query: mockDbQuery,
    getOne: vi.fn(async () => null),
    getMany: vi.fn(async () => []),
}));

// ── Mock ai-adapter ────────────────────────────────

const { mockSendPrompt } = vi.hoisted(() => ({
    mockSendPrompt: vi.fn(async () => ({
        text: '# Mock Design\n\nGenerated wireframe.',
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

import { Pixel } from '../../src/agents/specialists/pixel';
import type { TaskInfo } from '../../src/agents/autonaut-agent';
import { ProviderRegistry } from '../../src/agents/design/provider-registry';

// ── Test Setup ──────────────────────────────────────

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Test Design Task',
        description: 'Design a landing page for the product.',
        taskType: 'wireframe',
        phase: 'design-planning',
        outputPath: null,
        repoPath: '/tmp/test-repo',
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────

describe('Pixel agent', () => {
    let pixel: Pixel;

    beforeEach(() => {
        vi.clearAllMocks();
        pixel = new Pixel({ model: 'claude/claude-sonnet-4-20250514' });
    });

    describe('instantiation', () => {
        it('has correct name and role', () => {
            expect(pixel.name).toBe('pixel');
            expect(pixel.role).toBe('designer');
        });

        it('has expected skills', () => {
            expect(pixel.skills).toContain('ui-ux-design');
            expect(pixel.skills).toContain('wireframing');
            expect(pixel.skills).toContain('design-systems');
            expect(pixel.skills).toContain('accessibility');
            expect(pixel.skills.length).toBeGreaterThan(5);
        });

        it('starts idle with no current task', () => {
            expect(pixel.status).toBe('idle');
            expect(pixel.currentTask).toBeNull();
        });
    });

    describe('executeTask() dispatch', () => {
        it('handles wireframe task type', async () => {
            const task = createTask({ taskType: 'wireframe' });
            await pixel.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(2); // 1 brief + 1 wireframe
            const [, , userPrompt] = mockSendPrompt.mock.calls[1];
            expect(userPrompt).toContain('wireframe');
        });

        it('handles mockup task type', async () => {
            const task = createTask({ taskType: 'mockup' });
            await pixel.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(2); // 1 brief + 1 mockup
            const [, , userPrompt] = mockSendPrompt.mock.calls[1];
            expect(userPrompt).toContain('mockup');
        });

        it('handles design-system task type', async () => {
            const task = createTask({ taskType: 'design-system' });
            await pixel.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(2); // 1 brief + 1 design-system
            const [, , userPrompt] = mockSendPrompt.mock.calls[1];
            expect(userPrompt).toContain('design system');
        });

        it('handles user-flow task type', async () => {
            const task = createTask({ taskType: 'user-flow' });
            await pixel.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('user flow');
        });

        it('handles ui-review task type', async () => {
            const task = createTask({ taskType: 'ui-review' });
            await pixel.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('UI/UX review');
        });

        it('handles responsive-design task type', async () => {
            const task = createTask({ taskType: 'responsive-design' });
            await pixel.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('responsive');
        });

        it('falls back to generic handler for unknown task type', async () => {
            const task = createTask({ taskType: 'unknown-type' });
            await pixel.executeTask(task);

            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('Complete the following design task');
        });
    });

    describe('output file paths', () => {
        it('writes wireframe to default path', async () => {
            const task = createTask({ taskType: 'wireframe', outputPath: null });
            await pixel.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('wireframe.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('writes mockup to default path', async () => {
            const task = createTask({ taskType: 'mockup', outputPath: null });
            await pixel.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('mockup.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('uses custom outputPath when provided', async () => {
            const task = createTask({ taskType: 'wireframe', outputPath: 'custom/path.md' });
            await pixel.executeTask(task);

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('path.md'),
                expect.any(String),
                'utf-8'
            );
        });
    });

    describe('ui-build via design provider', () => {
        it('falls back to mockup when no registry is injected', async () => {
            const task = createTask({ taskType: 'ui-build' });
            await pixel.executeTask(task);

            // ui-build with no registry writes the mockup markdown spec instead
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.stringContaining('mockup.md'),
                expect.any(String),
                'utf-8'
            );
        });

        it('routes through the injected registry and writes returned files', async () => {
            // Use mockImplementationOnce twice so we do NOT leak state into
            // the next test. Call 1 is the design-brief generation; call 2
            // is the provider's generateUI call.
            mockSendPrompt.mockImplementationOnce(async () => ({
                text:
                    '# Brief\nPurpose: x\nAudience: y\nAesthetic: z\n' +
                    'Constraints: none\nAnti-Patterns: none\nInspirations: none',
                tokensIn: 80,
                tokensOut: 120,
                costUsd: 0.001,
                model: 'claude/claude-sonnet-4-6',
                durationMs: 200,
            }));
            mockSendPrompt.mockImplementationOnce(async () => ({
                text:
                    '--- FILE: index.html ---\n' +
                    '<!doctype html><html><body><main id="root">hi</main></body></html>\n' +
                    '--- END FILE ---\n' +
                    '--- FILE: styles.css ---\n' +
                    'body { margin: 0 }\n' +
                    '--- END FILE ---',
                tokensIn: 500,
                tokensOut: 800,
                costUsd: 0.012,
                model: 'claude/claude-sonnet-4-6',
                durationMs: 900,
            }));

            const registry = new ProviderRegistry({
                inHouse: { model: 'claude/claude-sonnet-4-6' },
                claudeUi: { model: 'claude/claude-sonnet-4-6' },
            });
            const pixelWithProvider = new Pixel(
                { model: 'claude/claude-sonnet-4-6' },
                { registry, providerId: 'claude-ui' }
            );

            const task = createTask({ taskType: 'ui-build' });
            await pixelWithProvider.executeTask(task);

            const paths = mockWriteFileSync.mock.calls.map((c) => c[0] as string);
            expect(paths.some((p) => p.endsWith('index.html'))).toBe(true);
            expect(paths.some((p) => p.endsWith('styles.css'))).toBe(true);
        });

        it('logs provider cost into agent_logs so budget-kill sees it', async () => {
            mockSendPrompt.mockImplementationOnce(async () => ({
                text: '# Brief\nPurpose: x\nAudience: y\nAesthetic: z\nConstraints: none\nAnti-Patterns: none\nInspirations: none',
                tokensIn: 80,
                tokensOut: 120,
                costUsd: 0.001,
                model: 'claude/claude-sonnet-4-6',
                durationMs: 200,
            }));
            mockSendPrompt.mockImplementationOnce(async () => ({
                text:
                    '--- FILE: index.html ---\n<html></html>\n--- END FILE ---',
                tokensIn: 500,
                tokensOut: 800,
                costUsd: 0.042,
                model: 'claude/claude-sonnet-4-6',
                durationMs: 900,
            }));

            const registry = new ProviderRegistry({
                inHouse: { model: 'claude/claude-sonnet-4-6' },
                claudeUi: { model: 'claude/claude-sonnet-4-6' },
            });
            const pixelWithProvider = new Pixel(
                { model: 'claude/claude-sonnet-4-6' },
                { registry, providerId: 'claude-ui' }
            );

            const task = createTask({ taskType: 'ui-build' });
            await pixelWithProvider.executeTask(task);

            // Find the agent_logs INSERT carrying the provider cost
            const logCalls = mockDbQuery.mock.calls.filter((c) =>
                typeof c[0] === 'string' && c[0].includes('INSERT INTO agent_logs')
            );
            const uiBuildLog = logCalls.find((c) => {
                const params = c[1] as unknown[] | undefined;
                return Array.isArray(params) && params[3] === 'ui-build';
            });
            expect(uiBuildLog).toBeDefined();
            if (uiBuildLog !== undefined) {
                const params = uiBuildLog[1] as unknown[];
                expect(params[4]).toBe('claude-ui'); // model_used = provider name
                expect(params[7]).toBeCloseTo(0.042, 6); // cost_usd
            }
        });
    });

    describe('AI interaction', () => {
        it('includes task title and description in prompt', async () => {
            const task = createTask({
                title: 'Dashboard Wireframe',
                description: 'Design a dashboard for analytics.',
            });
            await pixel.executeTask(task);

            const [, , userPrompt] = mockSendPrompt.mock.calls[0];
            expect(userPrompt).toContain('Dashboard Wireframe');
            expect(userPrompt).toContain('Design a dashboard for analytics.');
        });

        it('writes AI response text to file', async () => {
            await pixel.executeTask(createTask());

            expect(mockWriteFileSync).toHaveBeenCalledWith(
                expect.any(String),
                '# Mock Design\n\nGenerated wireframe.',
                'utf-8'
            );
        });
    });
});
