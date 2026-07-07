/**
 * Forge agent shell execution tests
 *
 * Tests ensureDependencies, runTests, runBuild, fixFailures,
 * and getExistingFilesContext without live AI or shell.
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
        text: '--- FILE: src/fix.ts ---\nconst x = 1;\n--- END FILE ---',
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

const { mockWriteFileSync, mockExistsSync, mockMkdirSync, mockReadFileSync, mockReaddirSync } = vi.hoisted(() => ({
    mockWriteFileSync: vi.fn(),
    mockExistsSync: vi.fn(() => true),
    mockMkdirSync: vi.fn(),
    mockReadFileSync: vi.fn(() => '{}'),
    mockReaddirSync: vi.fn(() => []),
}));

vi.mock('fs', () => ({
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    readdirSync: mockReaddirSync,
}));

// ── Mock child_process ──────────────────────────────

const { mockSpawn } = vi.hoisted(() => ({
    mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
    spawn: mockSpawn,
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

import { Forge } from '../../src/agents/specialists/forge';
import type { TaskInfo } from '../../src/agents/autonaut-agent';
import { EventEmitter } from 'events';

// ── Helpers ─────────────────────────────────────────

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Test Task',
        description: 'A test description.',
        taskType: 'implement',
        phase: 'development',
        outputPath: null,
        repoPath: '/tmp/test-repo',
        ...overrides,
    };
}

function createMockProcess(exitCode = 0): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();

    // Emit close on next tick so the promise resolves
    setTimeout(() => {
        proc.emit('close', exitCode);
    }, 5);

    return proc;
}

// ── Tests ───────────────────────────────────────────

describe('Forge shell execution', () => {
    let forge: Forge;

    beforeEach(() => {
        vi.clearAllMocks();
        forge = new Forge({ model: 'claude/claude-sonnet-4-20250514' });
    });

    describe('ensureDependencies', () => {
        it('runs npm install when package.json exists', async () => {
            mockExistsSync.mockReturnValue(true);
            mockSpawn.mockReturnValue(createMockProcess(0));

            const task = createTask();
            // Access private method via type cast
            await (forge as any).ensureDependencies(task);

            expect(mockSpawn).toHaveBeenCalledWith(
                'npm',
                // KO-SEC-004/019: --ignore-scripts contains lifecycle scripts
                // from an AI-generated package.json.
                ['install', '--no-audit', '--no-fund', '--ignore-scripts'],
                expect.objectContaining({ cwd: '/tmp/test-repo' })
            );
        });

        it('skips when no package.json', async () => {
            mockExistsSync.mockReturnValue(false);

            const task = createTask();
            await (forge as any).ensureDependencies(task);

            expect(mockSpawn).not.toHaveBeenCalled();
        });
    });

    describe('runTests', () => {
        it('runs npm test when test script exists', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'vitest run' } }));
            mockSpawn.mockReturnValue(createMockProcess(0));

            const task = createTask();
            const result = await (forge as any).runTests(task);

            expect(result).toBe(true);
            expect(mockSpawn).toHaveBeenCalledWith(
                'npm',
                ['test'],
                expect.objectContaining({ cwd: '/tmp/test-repo' })
            );
        });

        it('returns true when no test script', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { build: 'tsc' } }));

            const task = createTask();
            const result = await (forge as any).runTests(task);

            expect(result).toBe(true);
            expect(mockSpawn).not.toHaveBeenCalled();
        });
    });

    describe('runBuild', () => {
        it('runs npm run build when build script exists', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { build: 'tsc' } }));
            mockSpawn.mockReturnValue(createMockProcess(0));

            const task = createTask();
            const result = await (forge as any).runBuild(task);

            expect(result).toBe(true);
            expect(mockSpawn).toHaveBeenCalledWith(
                'npm',
                ['run', 'build'],
                expect.objectContaining({ cwd: '/tmp/test-repo' })
            );
        });
    });

    describe('fixFailures', () => {
        it('runs a single fix attempt (maxRetries=1)', async () => {
            // Both build and test always fail
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }));
            // Each call to executeCommand spawns a new process; all fail
            mockSpawn.mockImplementation(() => createMockProcess(1));

            const task = createTask();
            await (forge as any).fixFailures(task, 'error output', '');

            // askAI called once (cost-guard: maxRetries lowered from 2 → 1)
            expect(mockSendPrompt).toHaveBeenCalledTimes(1);
        });
    });

    describe('getExistingFilesContext', () => {
        it('includes .ts files and excludes node_modules', () => {
            const repoPath = '/tmp/test-repo';
            const resolved = require('path').resolve(repoPath);
            mockExistsSync.mockReturnValue(true);
            mockReaddirSync.mockImplementation((dir: string) => {
                const normalized = require('path').normalize(dir);
                if (normalized === resolved) {
                    return [
                        { name: 'index.ts', isDirectory: () => false },
                        { name: 'node_modules', isDirectory: () => true },
                        { name: 'src', isDirectory: () => true },
                    ];
                }
                // src subdirectory
                return [
                    { name: 'app.ts', isDirectory: () => false },
                ];
            });

            const result = (forge as any).getExistingFilesContext(repoPath);

            expect(result).toContain('index.ts');
            expect(result).toContain('app.ts');
            expect(result).not.toContain('node_modules');
        });
    });
});
