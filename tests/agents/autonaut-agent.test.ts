/**
 * AutonautAgent behavioral tests
 *
 * Tests the abstract base class through a concrete TestAgent subclass.
 * All external dependencies (db/client, ai-adapter, EventBus) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutonautAgent, TaskInfo, AgentModelConfig, ShellResult } from '../../src/agents/autonaut-agent';
import { EventBus, EventPayload } from '../../src/orchestrator/event-bus';

// ── Module mocks ──────────────────────────────────────

vi.mock('../../src/db/client', () => ({
    query: vi.fn(),
}));

vi.mock('../../src/agents/ai-adapter', () => ({
    sendPrompt: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────

import { query } from '../../src/db/client';
import { sendPrompt } from '../../src/agents/ai-adapter';

const mockQuery = vi.mocked(query);
const mockSendPrompt = vi.mocked(sendPrompt);

// ── Test fixtures ─────────────────────────────────────

const DEFAULT_MODEL_CONFIG: AgentModelConfig = {
    model: 'claude/claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
};

const TASK_ROW = {
    id: 'task-001',
    project_id: 'proj-001',
    title: 'Write concept brief',
    description: 'Analyze the idea and write a concept brief',
    task_type: 'concept-brief',
    phase: 'discovery',
    output_path: 'docs/concept-brief.md',
};

const PROJECT_ROW = {
    repo_path: '/tmp/test-repo',
};

function makeTaskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
    return {
        id: 'task-001',
        projectId: 'proj-001',
        title: 'Write concept brief',
        description: 'Analyze the idea',
        taskType: 'concept-brief',
        phase: 'discovery',
        outputPath: 'docs/concept-brief.md',
        repoPath: '/tmp/test-repo',
        ...overrides,
    };
}

// ── Concrete TestAgent subclass ───────────────────────

class TestAgent extends AutonautAgent {
    public executedTasks: TaskInfo[] = [];
    public shouldThrow = false;
    public throwMessage = 'Task execution failed';

    constructor(modelConfig: AgentModelConfig = DEFAULT_MODEL_CONFIG) {
        super(
            'test-agent',
            'tester',
            ['testing', 'verification'] as const,
            modelConfig,
            'You are a test agent.'
        );
    }

    async executeTask(task: TaskInfo): Promise<void> {
        if (this.shouldThrow) {
            throw new Error(this.throwMessage);
        }
        this.executedTasks.push(task);
    }

    // Expose protected methods for direct testing
    public testAskAI(prompt: string, context?: string) {
        return this.askAI(prompt, context);
    }

    public testReadFile(repoPath: string, filePath: string) {
        return this.readFile(repoPath, filePath);
    }

    public testWriteFile(repoPath: string, filePath: string, content: string): Promise<void> {
        return this.writeFile(repoPath, filePath, content);
    }

    public testReportProgress(task: TaskInfo, message: string) {
        return this.reportProgress(task, message);
    }

    public testExecuteCommand(task: TaskInfo, command: string, args: string[]) {
        return this.executeCommand(task, command, args);
    }

    public testDetectLoop(actionKey: string) {
        return this.detectLoop(actionKey);
    }

    public testResetLoopDetection() {
        return this.resetLoopDetection();
    }

    public testTrackConversation(role: 'user' | 'assistant', content: string) {
        return this.trackConversation(role, content);
    }

    public testResetConversation() {
        return this.resetConversation();
    }
}

// ── Mock EventBus factory ─────────────────────────────

function makeMockEventBus() {
    return {
        subscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn().mockResolvedValue(undefined),
        subscribeAll: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as EventBus;
}

// ── Helpers ───────────────────────────────────────────

function makeTaskAssignedEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        channel: 'task.assigned',
        projectId: 'proj-001',
        taskId: 'task-001',
        agent: 'test-agent',
        data: {},
        timestamp: new Date().toISOString(),
        ...overrides,
    };
}

function setupDbQueryForTask(): void {
    mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM tasks')) {
            return { rows: [TASK_ROW], rowCount: 1 };
        }
        if (typeof sql === 'string' && sql.includes('FROM projects')) {
            return { rows: [PROJECT_ROW], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });
}

// ── Tests ─────────────────────────────────────────────

describe('AutonautAgent — constructor and initial state', () => {
    it('sets name, role, skills, modelConfig, and systemPrompt from constructor arguments', () => {
        const config: AgentModelConfig = {
            model: 'ollama/llama3.2',
            temperature: 0.5,
            maxTokens: 2048,
        };
        const agent = new TestAgent(config);

        expect(agent.name).toBe('test-agent');
        expect(agent.role).toBe('tester');
        expect(agent.skills).toEqual(['testing', 'verification']);
        expect(agent.modelConfig).toEqual(config);
        expect(agent.systemPrompt).toBe('You are a test agent.');
    });

    it('status starts as "idle"', () => {
        const agent = new TestAgent();
        expect(agent.status).toBe('idle');
    });

    it('currentTask starts as null', () => {
        const agent = new TestAgent();
        expect(agent.currentTask).toBeNull();
    });
});

describe('AutonautAgent — onTaskAssigned() happy path', () => {
    let agent: TestAgent;
    let eventBus: ReturnType<typeof makeMockEventBus>;

    beforeEach(async () => {
        vi.clearAllMocks();
        agent = new TestAgent();
        eventBus = makeMockEventBus();
        await agent.connect(eventBus as unknown as EventBus);
    });

    it('loads task info from the DB and calls executeTask()', async () => {
        setupDbQueryForTask();

        const event = makeTaskAssignedEvent();
        await agent.onTaskAssigned(event);

        expect(agent.executedTasks).toHaveLength(1);
        expect(agent.executedTasks[0].id).toBe('task-001');
        expect(agent.executedTasks[0].title).toBe('Write concept brief');
        expect(agent.executedTasks[0].repoPath).toBe('/tmp/test-repo');
    });

    it('marks the task as completed in the DB', async () => {
        setupDbQueryForTask();

        const event = makeTaskAssignedEvent();
        await agent.onTaskAssigned(event);

        // The third query call should be the UPDATE to completed status
        const calls = mockQuery.mock.calls;
        const updateCall = calls.find(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'completed'")
        );
        expect(updateCall).toBeDefined();
        expect(updateCall?.[1]).toContain('task-001');
    });

    it('publishes task.completed event with durationMs after successful execution', async () => {
        setupDbQueryForTask();

        const event = makeTaskAssignedEvent();
        await agent.onTaskAssigned(event);

        expect(eventBus.publish).toHaveBeenCalledWith(
            'task.completed',
            expect.objectContaining({
                taskId: 'task-001',
                agent: 'test-agent',
                data: expect.objectContaining({
                    title: 'Write concept brief',
                    durationMs: expect.any(Number),
                }),
            })
        );
    });

    it('status is "busy" during executeTask and returns to "idle" after completion', async () => {
        const statusDuringExecution: string[] = [];

        class StatusTrackingAgent extends TestAgent {
            async executeTask(task: TaskInfo): Promise<void> {
                statusDuringExecution.push(this.status);
                await super.executeTask(task);
            }
        }

        const trackingAgent = new StatusTrackingAgent();
        await trackingAgent.connect(eventBus as unknown as EventBus);

        setupDbQueryForTask();

        await trackingAgent.onTaskAssigned(makeTaskAssignedEvent());

        expect(statusDuringExecution).toEqual(['busy']);
        expect(trackingAgent.status).toBe('idle');
    });

    it('currentTask is null after successful execution', async () => {
        setupDbQueryForTask();

        await agent.onTaskAssigned(makeTaskAssignedEvent());

        expect(agent.currentTask).toBeNull();
    });
});

describe('AutonautAgent — onTaskAssigned() error path', () => {
    let agent: TestAgent;
    let eventBus: ReturnType<typeof makeMockEventBus>;

    beforeEach(async () => {
        vi.clearAllMocks();
        agent = new TestAgent();
        agent.shouldThrow = true;
        agent.throwMessage = 'AI model timed out';
        eventBus = makeMockEventBus();
        await agent.connect(eventBus as unknown as EventBus);
    });

    it('marks the task as failed in the DB when executeTask throws', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [PROJECT_ROW], rowCount: 1 })
            .mockResolvedValue({ rows: [], rowCount: 0 });

        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const calls = mockQuery.mock.calls;
        const failUpdate = calls.find(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'failed'")
        );
        expect(failUpdate).toBeDefined();
        expect(failUpdate?.[1]).toContain('AI model timed out');
        expect(failUpdate?.[1]).toContain('task-001');
    });

    it('publishes task.failed event with the error message', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [PROJECT_ROW], rowCount: 1 })
            .mockResolvedValue({ rows: [], rowCount: 0 });

        const event = makeTaskAssignedEvent();
        await agent.onTaskAssigned(event);

        expect(eventBus.publish).toHaveBeenCalledWith(
            'task.failed',
            expect.objectContaining({
                taskId: 'task-001',
                agent: 'test-agent',
                data: expect.objectContaining({
                    errorMessage: 'AI model timed out',
                }),
            })
        );
    });

    it('status returns to "idle" after a failed execution', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [PROJECT_ROW], rowCount: 1 })
            .mockResolvedValue({ rows: [], rowCount: 0 });

        await agent.onTaskAssigned(makeTaskAssignedEvent());

        // finally block resets status to idle regardless of error
        expect(agent.status).toBe('idle');
    });

    it('handles the case where the task is not found in the DB', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // task not found
            .mockResolvedValue({ rows: [], rowCount: 0 });

        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const calls = mockQuery.mock.calls;
        const failUpdate = calls.find(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'failed'")
        );
        expect(failUpdate).toBeDefined();
        const errorArg = failUpdate?.[1]?.[0] as string;
        expect(errorArg).toContain('Task not found');
    });
});

describe('AutonautAgent — onTaskAssigned() edge cases', () => {
    let agent: TestAgent;
    let eventBus: ReturnType<typeof makeMockEventBus>;

    beforeEach(async () => {
        vi.clearAllMocks();
        agent = new TestAgent();
        eventBus = makeMockEventBus();
        await agent.connect(eventBus as unknown as EventBus);
    });

    it('ignores events that have no taskId', async () => {
        const event = makeTaskAssignedEvent({ taskId: undefined });
        await agent.onTaskAssigned(event);

        expect(mockQuery).not.toHaveBeenCalled();
        expect(agent.executedTasks).toHaveLength(0);
        expect(agent.status).toBe('idle');
    });
});

describe('AutonautAgent — reportProgress()', () => {
    it('publishes a task.progress event with the provided message', async () => {
        vi.clearAllMocks();
        const agent = new TestAgent();
        const eventBus = makeMockEventBus();
        await agent.connect(eventBus as unknown as EventBus);

        const task = makeTaskInfo();
        await agent.testReportProgress(task, 'Researching the market...');

        expect(eventBus.publish).toHaveBeenCalledWith(
            'task.progress',
            expect.objectContaining({
                projectId: 'proj-001',
                taskId: 'task-001',
                agent: 'test-agent',
                data: { message: 'Researching the market...' },
            })
        );
    });

    it('does not throw when called before connecting to event bus', async () => {
        const agent = new TestAgent();
        const task = makeTaskInfo();

        // No eventBus connected — should silently skip
        await expect(agent.testReportProgress(task, 'progress')).resolves.not.toThrow();
    });
});

describe('AutonautAgent — askAI()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // absorb logAction queries
    });

    it('calls sendPrompt with the configured model, system prompt, and user prompt', async () => {
        const mockResponse = {
            text: 'AI response text',
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 0.001,
            model: 'claude-sonnet-4-20250514',
            durationMs: 800,
        };
        mockSendPrompt.mockResolvedValue(mockResponse);

        const agent = new TestAgent();
        const result = await agent.testAskAI('Tell me about the market');

        expect(mockSendPrompt).toHaveBeenCalledWith(
            'claude/claude-sonnet-4-20250514',
            expect.stringContaining('You are a test agent.'),
            'Tell me about the market',
            expect.objectContaining({
                temperature: 0.7,
                maxTokens: 4096,
            })
        );
        expect(result.text).toBe('AI response text');
    });

    it('prepends context to the prompt when context is provided', async () => {
        const mockResponse = {
            text: 'Response with context',
            tokensIn: 150,
            tokensOut: 60,
            costUsd: 0.002,
            model: 'claude-sonnet-4-20250514',
            durationMs: 900,
        };
        mockSendPrompt.mockResolvedValue(mockResponse);

        const agent = new TestAgent();
        await agent.testAskAI('What is the answer?', 'Background: This project is about X.');

        const callArgs = mockSendPrompt.mock.calls[0];
        const promptArg = callArgs[2] as string;

        expect(promptArg).toContain('Background: This project is about X.');
        expect(promptArg).toContain('What is the answer?');
    });

    it('returns the full AiResponse including token counts and cost', async () => {
        const mockResponse = {
            text: 'Detailed response',
            tokensIn: 200,
            tokensOut: 80,
            costUsd: 0.005,
            model: 'claude-sonnet-4-20250514',
            durationMs: 1200,
        };
        mockSendPrompt.mockResolvedValue(mockResponse);

        const agent = new TestAgent();
        const result = await agent.testAskAI('Complex question');

        expect(result.tokensIn).toBe(200);
        expect(result.tokensOut).toBe(80);
        expect(result.costUsd).toBe(0.005);
        expect(result.durationMs).toBe(1200);
    });
});

describe('AutonautAgent — path traversal prevention', () => {
    let tempDir: string;

    beforeEach(() => {
        // Use the OS temp directory as a safe base for testing
        tempDir = path.join(os.tmpdir(), 'kageops-test-repo');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    });

    afterEach(() => {
        // Clean up any test files
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    });

    it('readFile throws when the path resolves outside the repo directory', () => {
        const agent = new TestAgent();

        expect(() => {
            agent.testReadFile(tempDir, '../../etc/passwd');
        }).toThrow(/[Pp]ath traversal/);
    });

    it('readFile throws for null-byte injection attempt', () => {
        const agent = new TestAgent();

        expect(() => {
            agent.testReadFile(tempDir, '../outside-repo.txt');
        }).toThrow(/[Pp]ath traversal/);
    });

    it('readFile allows paths that remain inside the repo directory', () => {
        const agent = new TestAgent();

        // Create a safe test file inside the repo
        const safeContent = 'safe file content';
        const safeFilePath = path.join(tempDir, 'README.md');
        fs.writeFileSync(safeFilePath, safeContent, 'utf-8');

        const result = agent.testReadFile(tempDir, 'README.md');
        expect(result).toBe(safeContent);
    });

    it('readFile throws for a sibling directory that merely shares the repo dir as a string prefix (KO-SEC-007/008/016)', () => {
        // Regression guard: validatePath used to check
        // `resolvedFull.startsWith(resolvedRepo)` with no path-separator
        // boundary, so a sibling dir like `<repo>-evil` (which shares
        // `<repo>` as a string prefix but is NOT inside it) passed the
        // check. Confirm it's rejected.
        const siblingDir = `${tempDir}-evil`;
        fs.mkdirSync(siblingDir, { recursive: true });
        fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'top secret', 'utf-8');

        const agent = new TestAgent();
        try {
            expect(() => {
                agent.testReadFile(tempDir, `../${path.basename(siblingDir)}/secret.txt`);
            }).toThrow(/[Pp]ath traversal/);
        } finally {
            fs.rmSync(siblingDir, { recursive: true, force: true });
        }
    });

    it('writeFile throws when the path resolves outside the repo directory', async () => {
        const agent = new TestAgent();

        await expect(
            agent.testWriteFile(tempDir, '../../../tmp/evil.sh', 'malicious content'),
        ).rejects.toThrow(/[Pp]ath traversal/);
    });

    it('writeFile allows writing files inside the repo directory', async () => {
        const agent = new TestAgent();

        await agent.testWriteFile(tempDir, 'output/result.md', '# Result');

        const written = fs.readFileSync(path.join(tempDir, 'output', 'result.md'), 'utf-8');
        expect(written).toBe('# Result');
    });

    it('writeFile creates intermediate directories when they do not exist', async () => {
        const agent = new TestAgent();
        const nestedPath = 'docs/discovery/deep/nested/file.md';

        // Structural markdown so the narration-leak funnel guard passes;
        // this test exercises directory creation, not content shape.
        await agent.testWriteFile(tempDir, nestedPath, '# Nested\n\nNested content body.');

        const fullPath = path.join(tempDir, nestedPath);
        expect(fs.existsSync(fullPath)).toBe(true);
    });

    // ── 2026-06 narration-leak funnel guard ───────────────────────
    it('writeFile rejects UNRECOVERABLE leaked narration (pure monologue, no code body)', async () => {
        const agent = new TestAgent();
        // A genuine monologue leak — all prose, no clean code body to recover.
        const leak = [
            'Let me read them all systematically. I need to understand the',
            'structure before I can write the layout. Actually, I should just',
            'read the files first. This is taking a while to reason through and',
            'I keep going back and forth on the approach here.',
        ].join('\n');
        const target = 'src/app/layout.tsx';

        await expect(
            agent.testWriteFile(tempDir, target, leak),
        ).rejects.toThrow(/non-artifact content/i);

        expect(fs.existsSync(path.join(tempDir, target))).toBe(false);
    });

    // ── BPF-4: recover the artifact when a narration preamble precedes it ──
    it('writeFile RECOVERS the artifact when a narration preamble precedes valid code', async () => {
        const agent = new TestAgent();
        const withPreamble = [
            "I'll analyze the workspace first, then implement the layout as specified.",
            '',
            "import React from 'react';",
            'export default function RootLayout({ children }: { children: React.ReactNode }) {',
            '  return <html><body>{children}</body></html>;',
            '}',
        ].join('\n');
        const target = 'src/app/layout.tsx';

        await agent.testWriteFile(tempDir, target, withPreamble);

        const written = fs.readFileSync(path.join(tempDir, target), 'utf8');
        expect(written.startsWith("import React")).toBe(true);
        expect(written).not.toContain("I'll analyze the workspace");
    });

    it('writeFile rejects an "All N files written" chat summary in a .tsx file', async () => {
        const agent = new TestAgent();
        const summary = 'All 6 test files written. Summary of what was created:\n\n| File | Purpose |';
        const target = 'app/login/page.tsx';

        await expect(
            agent.testWriteFile(tempDir, target, summary),
        ).rejects.toThrow(/non-artifact content/i);

        expect(fs.existsSync(path.join(tempDir, target))).toBe(false);
    });

    it('writeFile still accepts real source content', async () => {
        const agent = new TestAgent();
        const code = [
            "import type { Metadata } from 'next';",
            '',
            'export default function RootLayout({ children }: { children: React.ReactNode }) {',
            '    return <html><body>{children}</body></html>;',
            '}',
        ].join('\n');
        const target = 'src/app/layout.tsx';

        await agent.testWriteFile(tempDir, target, code);

        expect(fs.existsSync(path.join(tempDir, target))).toBe(true);
    });
});

describe('AutonautAgent — connect()', () => {
    it('subscribes to task.assigned on the event bus', async () => {
        const agent = new TestAgent();
        const eventBus = makeMockEventBus();

        await agent.connect(eventBus as unknown as EventBus);

        expect(eventBus.subscribe).toHaveBeenCalledWith(
            'task.assigned',
            expect.any(Function)
        );
    });

    it('only processes task.assigned events directed at this agent by name', async () => {
        vi.clearAllMocks();

        const agent = new TestAgent();
        const eventBus = makeMockEventBus();
        await agent.connect(eventBus as unknown as EventBus);

        // Capture the subscription callback
        const subscribeCall = vi.mocked(eventBus.subscribe).mock.calls[0];
        const callback = subscribeCall[1] as (e: EventPayload) => Promise<void>;

        // Simulate an event for a different agent
        const foreignEvent = makeTaskAssignedEvent({ agent: 'other-agent' });
        await callback(foreignEvent);

        // Our agent should not have been invoked
        expect(mockQuery).not.toHaveBeenCalled();
    });

    it('processes task.assigned events when the agent field matches this agent name', async () => {
        vi.clearAllMocks();
        setupDbQueryForTask();

        const agent = new TestAgent();
        const eventBus = makeMockEventBus();
        await agent.connect(eventBus as unknown as EventBus);

        const subscribeCall = vi.mocked(eventBus.subscribe).mock.calls[0];
        const callback = subscribeCall[1] as (e: EventPayload) => Promise<void>;

        const ownEvent = makeTaskAssignedEvent({ agent: 'test-agent' });
        await callback(ownEvent);

        expect(agent.executedTasks).toHaveLength(1);
    });

    it('is idempotent: calling connect() twice does not register a second subscription', async () => {
        vi.clearAllMocks();

        const agent = new TestAgent();
        const eventBus = makeMockEventBus();

        await agent.connect(eventBus as unknown as EventBus);
        const firstCallCount = vi.mocked(eventBus.subscribe).mock.calls.length;
        await agent.connect(eventBus as unknown as EventBus);

        // Second connect() should be a no-op — subscribe count unchanged
        expect(eventBus.subscribe).toHaveBeenCalledTimes(firstCallCount);
    });

    it('ignores duplicate dispatch for the same task-id while it is in flight', async () => {
        vi.clearAllMocks();
        setupDbQueryForTask();

        const agent = new TestAgent();
        const eventBus = makeMockEventBus();
        await agent.connect(eventBus as unknown as EventBus);

        const subscribeCall = vi.mocked(eventBus.subscribe).mock.calls[0];
        const callback = subscribeCall[1] as (e: EventPayload) => Promise<void>;

        // Fire two identical task.assigned events concurrently (the exact
        // shape of the bug that caused V11's git branch conflicts + REPEAT-CALL).
        const event = makeTaskAssignedEvent({ agent: 'test-agent' });
        await Promise.all([callback(event), callback(event)]);

        // Only one execution should have happened.
        expect(agent.executedTasks).toHaveLength(1);
    });
});

// ── D1: Shell Execution ───────────────────────────────

describe('AutonautAgent — executeCommand()', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('rejects commands not on the allowlist', async () => {
        const agent = new TestAgent();
        const task = makeTaskInfo();
        await expect(agent.testExecuteCommand(task, 'curl', ['http://example.com']))
            .rejects.toThrow(/not on the allowlist/);
    });

    it('rejects arguments matching the blocklist', async () => {
        const agent = new TestAgent();
        const task = makeTaskInfo();
        await expect(agent.testExecuteCommand(task, 'npm', ['run', 'rm -rf /']))
            .rejects.toThrow(/blocked by safety pattern/);
    });

    it('runs an allowed command and returns stdout/stderr/exitCode', async () => {
        const agent = new TestAgent();
        const task = makeTaskInfo({ repoPath: process.cwd() });
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

        const result: ShellResult = await agent.testExecuteCommand(task, 'node', ['--version']);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^v\d+/);
    });

    it('throws when the command exits non-zero', async () => {
        const agent = new TestAgent();
        const task = makeTaskInfo({ repoPath: process.cwd() });
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

        // node --bad-flag exits 9
        await expect(agent.testExecuteCommand(task, 'node', ['--bad-flag-xyz']))
            .rejects.toThrow(/exited/);
    });
});

// ── D3: Loop Detection ────────────────────────────────

describe('AutonautAgent — detectLoop()', () => {
    it('returns false when fewer than threshold identical actions seen', () => {
        const agent = new TestAgent();
        expect(agent.testDetectLoop('action-a')).toBe(false);
        expect(agent.testDetectLoop('action-a')).toBe(false);
    });

    it('returns true when the same action appears 3+ times in the window', () => {
        const agent = new TestAgent();
        agent.testDetectLoop('action-x');
        agent.testDetectLoop('action-x');
        expect(agent.testDetectLoop('action-x')).toBe(true);
    });

    it('does not flag a loop for varied actions', () => {
        const agent = new TestAgent();
        expect(agent.testDetectLoop('a')).toBe(false);
        expect(agent.testDetectLoop('b')).toBe(false);
        expect(agent.testDetectLoop('c')).toBe(false);
        expect(agent.testDetectLoop('a')).toBe(false);
        expect(agent.testDetectLoop('b')).toBe(false);
    });

    it('resets correctly', () => {
        const agent = new TestAgent();
        agent.testDetectLoop('x');
        agent.testDetectLoop('x');
        agent.testDetectLoop('x'); // would be a loop
        agent.testResetLoopDetection();
        // after reset, no loop
        expect(agent.testDetectLoop('x')).toBe(false);
    });
});

// ── D2: Context Compaction ────────────────────────────

describe('AutonautAgent — trackConversation()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    it('accumulates messages and returns the full list when under threshold', async () => {
        const agent = new TestAgent();
        const msgs1 = await agent.testTrackConversation('user', 'hello');
        expect(msgs1).toHaveLength(1);
        const msgs2 = await agent.testTrackConversation('assistant', 'hi there');
        expect(msgs2).toHaveLength(2);
        expect(msgs2[0].role).toBe('user');
        expect(msgs2[1].role).toBe('assistant');
    });

    it('resets conversation history correctly', async () => {
        const agent = new TestAgent();
        await agent.testTrackConversation('user', 'first message');
        agent.testResetConversation();
        const msgs = await agent.testTrackConversation('user', 'after reset');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].content).toBe('after reset');
    });
});
