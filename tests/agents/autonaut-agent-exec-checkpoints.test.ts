/**
 * AutonautAgent — P1-01d executeCommand() checkpointing wiring.
 *
 * Exercises cache hit + miss + failure paths for shell exec checkpoints.
 * Companion to:
 *   - autonaut-agent-checkpoints.test.ts        (askAI)
 *   - autonaut-agent-write-checkpoints.test.ts  (writeFile)
 *
 * Uses an `npmStub` spawn helper instead of executing real commands —
 * the agent's `spawnWithTimeout` is overridden via a test subclass so
 * we never actually invoke node/npm/git from the test runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    AutonautAgent,
    TaskInfo,
    AgentModelConfig,
    ShellResult,
    ExecCheckpointOutput,
} from '../../src/agents/autonaut-agent';
import { EventBus, EventPayload } from '../../src/orchestrator/event-bus';
import {
    createInMemoryTaskCheckpointRepository,
    TaskCheckpointRepository,
} from '../../src/db/task-checkpoint-repo';

vi.mock('../../src/db/client', () => ({ query: vi.fn() }));
import { query } from '../../src/db/client';
const mockQuery = vi.mocked(query);

// ── Fixtures ──────────────────────────────────────────

const DEFAULT_MODEL: AgentModelConfig = {
    model: 'claude/claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
};

const TASK_ROW = {
    id: 'task-exec-001',
    project_id: 'proj-001',
    title: 'Exec checkpoint smoke task',
    description: 'Run a few shell commands',
    task_type: 'general',
    phase: 'discovery',
    output_path: null,
};

function setupDbQueryForTask(): void {
    mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM tasks')) {
            return { rows: [TASK_ROW], rowCount: 1 };
        }
        if (typeof sql === 'string' && sql.includes('FROM projects')) {
            return { rows: [{ repo_path: '/tmp/exec-repo' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });
}

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

function makeTaskAssignedEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        channel: 'task.assigned',
        projectId: 'proj-001',
        taskId: 'task-exec-001',
        agent: 'exec-checkpoint-test-agent',
        data: {},
        timestamp: new Date().toISOString(),
        ...overrides,
    };
}

interface ExecPlan {
    readonly command: string;
    readonly args: string[];
    readonly result: ShellResult | (() => Promise<ShellResult>);
}

/**
 * Test agent that overrides spawnWithTimeout so no real subprocess
 * runs. Each entry in `plan` corresponds to one executeCommand call;
 * the result can be a plain ShellResult or a thunk that returns one
 * (so we can simulate rejection).
 */
class ExecTestAgent extends AutonautAgent {
    public plan: ExecPlan[] = [];
    public spawnCallCount = 0;

    constructor() {
        super(
            'exec-checkpoint-test-agent',
            'tester',
            [],
            DEFAULT_MODEL,
            'You are an exec-checkpoint test agent.',
        );
    }

    async executeTask(task: TaskInfo): Promise<void> {
        for (const entry of this.plan) {
            // Swallow the throw-on-non-zero-exit so the rest of the
            // plan still runs; tests assert on the cached state, not
            // on the propagated rejection.
            try {
                await this.executeCommand(task, entry.command, entry.args);
            } catch {
                /* expected for non-zero exit / spawn rejection */
            }
        }
    }

    protected override spawnWithTimeout(
        command: string,
        args: string[],
        _cwd: string,
        _timeoutMs: number,
    ): Promise<ShellResult> {
        const entry = this.plan[this.spawnCallCount];
        this.spawnCallCount += 1;
        if (entry === undefined) {
            throw new Error(`Test plan exhausted at spawn #${this.spawnCallCount} for ${command} ${args.join(' ')}`);
        }
        if (typeof entry.result === 'function') {
            return entry.result();
        }
        return Promise.resolve(entry.result);
    }
}

// ── Tests ─────────────────────────────────────────────

describe('AutonautAgent — executeCommand() checkpoint wiring (P1-01d)', () => {
    let agent: ExecTestAgent;
    let eventBus: ReturnType<typeof makeMockEventBus>;
    let repo: TaskCheckpointRepository;

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'true';
        setupDbQueryForTask();
        agent = new ExecTestAgent();
        eventBus = makeMockEventBus();
        repo = createInMemoryTaskCheckpointRepository();
        agent.setTaskCheckpointRepo(repo);
        await agent.connect(eventBus as unknown as EventBus);
    });

    afterEach(() => {
        delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
    });

    it('records one in-flight → completed checkpoint per executeCommand call', async () => {
        agent.plan = [
            { command: 'npm', args: ['install'], result: { stdout: 'ok', stderr: '', exitCode: 0 } },
            { command: 'npm', args: ['test'], result: { stdout: '12 passing', stderr: '', exitCode: 0 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const rows = await repo.listForTask('task-exec-001');
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.opIndex)).toEqual([0, 1]);
        expect(rows.every((r) => r.status === 'completed')).toBe(true);
        expect(rows.every((r) => r.opType === 'exec')).toBe(true);
        expect(agent.spawnCallCount).toBe(2);
    });

    it('persists command/args/cwd in payload and exit + previews + durationMs in output', async () => {
        agent.plan = [{
            command: 'npm', args: ['test', '--silent'],
            result: { stdout: '15 passing', stderr: '0 failures', exitCode: 0 },
        }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const [row] = await repo.listForTask('task-exec-001');
        const payload = row.payloadJson as { command: string; args: string[]; cwd: string; cmd: string };
        expect(payload.command).toBe('npm');
        expect(payload.args).toEqual(['test', '--silent']);
        expect(payload.cwd).toBe('/tmp/exec-repo');
        expect(payload.cmd).toBe('npm');

        const output = row.outputJson as ExecCheckpointOutput;
        expect(output.exitCode).toBe(0);
        expect(output.stdoutPreview).toBe('15 passing');
        expect(output.stderrPreview).toBe('0 failures');
        expect(typeof output.durationMs).toBe('number');
    });

    it('serves a cache hit on resume — does not spawn, returns the cached ShellResult', async () => {
        agent.plan = [
            { command: 'npm', args: ['test'], result: { stdout: '21 passing', stderr: '', exitCode: 0 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        // Resume: a fresh agent inherits the repo state, no spawn happens
        const resumed = new ExecTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        // Plan empty intentionally — if the code spawns we'd throw.
        resumed.plan = [
            { command: 'npm', args: ['test'], result: { stdout: 'should-not-run', stderr: '', exitCode: 99 } },
        ];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        expect(resumed.spawnCallCount).toBe(0);
        const rows = await repo.listForTask('task-exec-001');
        expect(rows).toHaveLength(1); // still one row, not duplicated
        expect(rows[0].status).toBe('completed');
    });

    it('re-executes live when the resume command differs (cmd guard, no stale serve)', async () => {
        agent.plan = [
            { command: 'npm', args: ['test'], result: { stdout: '21 passing', stderr: '', exitCode: 0 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        // Resume with a DIFFERENT command at op-index 0 (divergent re-run).
        // The guard must NOT replay the cached `npm test` result — it must
        // spawn the new command for real.
        const resumed = new ExecTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.plan = [
            { command: 'npm', args: ['run', 'build'], result: { stdout: 'built', stderr: '', exitCode: 0 } },
        ];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        expect(resumed.spawnCallCount).toBe(1); // re-executed, not served from cache
    });

    it('re-throws on cache-hit replay when the cached exit code was non-zero', async () => {
        agent.plan = [
            { command: 'npm', args: ['test'], result: { stdout: '', stderr: '3 tests failed', exitCode: 1 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());
        // The original task swallowed the throw; the row is completed.
        expect((await repo.listForTask('task-exec-001'))[0].status).toBe('completed');

        // Resume: the cache hit path must throw too, so consumers
        // (BuildVerificationGate) see the same failure.
        const resumed = new ExecTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        const taskInfo: TaskInfo = {
            id: 'task-exec-001', projectId: 'proj-001', title: 't',
            description: 'd', taskType: 'general', phase: 'discovery',
            outputPath: null, repoPath: '/tmp/exec-repo',
        };
        // Drive executeCommand directly through onTaskAssigned by
        // setting _currentTask via a real task assignment.
        let caughtMessage: string | null = null;
        class ThrowingPlanAgent extends ExecTestAgent {
            async executeTask(task: TaskInfo): Promise<void> {
                try {
                    await this.executeCommand(task, 'npm', ['test']);
                } catch (err) {
                    caughtMessage = err instanceof Error ? err.message : String(err);
                }
            }
        }
        const throwing = new ThrowingPlanAgent();
        throwing.setTaskCheckpointRepo(repo);
        await throwing.connect(makeMockEventBus() as unknown as EventBus);
        await throwing.onTaskAssigned(makeTaskAssignedEvent());

        expect(throwing.spawnCallCount).toBe(0);
        expect(caughtMessage).toMatch(/exited 1/);
        expect(caughtMessage).toMatch(/3 tests failed/);
        // Reference taskInfo so the unused-var rule doesn't fire — keeps the example shape readable.
        void taskInfo;
    });

    it('serves cache-hit with full preview bytes intact (within EXEC_PREVIEW_BYTES cap)', async () => {
        const longOut = 'a'.repeat(200);
        agent.plan = [
            { command: 'npm', args: ['run', 'build'], result: { stdout: longOut, stderr: '', exitCode: 0 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const resumed = new ExecTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        let captured: ShellResult | null = null;
        class CaptureAgent extends ExecTestAgent {
            async executeTask(task: TaskInfo): Promise<void> {
                captured = await this.executeCommand(task, 'npm', ['run', 'build']);
            }
        }
        const capture = new CaptureAgent();
        capture.setTaskCheckpointRepo(repo);
        await capture.connect(makeMockEventBus() as unknown as EventBus);
        await capture.onTaskAssigned(makeTaskAssignedEvent());

        expect(captured).not.toBeNull();
        expect(captured!.stdout).toBe(longOut);
        expect(capture.spawnCallCount).toBe(0);
    });

    it('truncates very large stdout to EXEC_PREVIEW_BYTES (4000) in cached output', async () => {
        const huge = 'x'.repeat(10_000);
        agent.plan = [
            { command: 'npm', args: ['test'], result: { stdout: huge, stderr: '', exitCode: 0 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const [row] = await repo.listForTask('task-exec-001');
        const output = row.outputJson as ExecCheckpointOutput;
        expect(output.stdoutPreview.length).toBe(4000);
        expect(output.stdoutPreview).toBe('x'.repeat(4000));
    });

    it('emits a shell-exec-end stream event with cached:true on a hit', async () => {
        agent.plan = [
            { command: 'npm', args: ['test'], result: { stdout: '', stderr: '', exitCode: 0 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const resumed = new ExecTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        const resumedBus = makeMockEventBus();
        await resumed.connect(resumedBus as unknown as EventBus);
        resumed.plan = [
            { command: 'npm', args: ['test'], result: { stdout: '', stderr: '', exitCode: 0 } },
        ];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        const ends = (resumedBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c) => c[0] === 'agent.stream' && (c[1] as { data: { type: string } }).data.type === 'shell-exec-end',
        );
        expect(ends.length).toBeGreaterThanOrEqual(1);
        const cached = ends.find((c) => (c[1] as { data: { cached?: boolean } }).data.cached === true);
        expect(cached).toBeDefined();
    });

    it('writes a shell-exec-cache-hit row to agent_logs on a hit', async () => {
        agent.plan = [
            { command: 'npm', args: ['ci'], result: { stdout: 'ok', stderr: '', exitCode: 0 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        mockQuery.mockClear();
        setupDbQueryForTask();
        const resumed = new ExecTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.plan = [
            { command: 'npm', args: ['ci'], result: { stdout: 'ok', stderr: '', exitCode: 0 } },
        ];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        const insertCalls = mockQuery.mock.calls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_logs'),
        );
        const hitInsert = insertCalls.find((c) => (c[1] as unknown[])[3] === 'shell-exec-cache-hit');
        expect(hitInsert).toBeDefined();
        const metadata = JSON.parse((hitInsert![1] as unknown[])[9] as string) as { command: string; cachedFromCheckpointId: string };
        expect(metadata.command).toBe('npm');
        expect(metadata.cachedFromCheckpointId).toMatch(/^ck-/);
    });

    it('marks the row failed when spawnWithTimeout rejects (timeout/ENOENT path)', async () => {
        agent.plan = [
            { command: 'npm', args: ['install'], result: async (): Promise<ShellResult> => {
                throw new Error('Command \'npm\' timed out after 300s');
            } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const rows = await repo.listForTask('task-exec-001');
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('failed');
        expect(rows[0].errorText).toMatch(/timed out/);
    });

    it('overwrites an in-flight row at same op-index instead of inserting twice', async () => {
        await repo.recordStart({
            taskId: 'task-exec-001',
            opIndex: 0,
            opType: 'exec',
            payloadJson: { command: 'npm', args: ['old'], cwd: '/tmp/exec-repo', cmd: 'npm' },
        });

        agent.plan = [
            { command: 'npm', args: ['test'], result: { stdout: 'new', stderr: '', exitCode: 0 } },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const rows = await repo.listForTask('task-exec-001');
        expect(rows).toHaveLength(1);
        expect(rows[0].opIndex).toBe(0);
        expect(rows[0].status).toBe('completed');
        expect((rows[0].outputJson as ExecCheckpointOutput).stdoutPreview).toBe('new');
    });

    it('still enforces allowlist on a cache hit (security comes first, even on resume)', async () => {
        // Seed a (technically impossible — allowlist-blocked) completed row to prove
        // the validation runs before findByOp would ever fire.
        await repo.recordStart({
            taskId: 'task-exec-001',
            opIndex: 0,
            opType: 'exec',
            payloadJson: { command: 'rm', args: ['-rf', '/'], cwd: '/tmp/exec-repo', cmd: 'rm' },
        });
        await repo.markCompleted(
            (await repo.listForTask('task-exec-001'))[0].id,
            { exitCode: 0, stdoutPreview: '', stderrPreview: '', durationMs: 0 },
        );

        let caught: string | null = null;
        class TryRmAgent extends ExecTestAgent {
            async executeTask(task: TaskInfo): Promise<void> {
                try {
                    await this.executeCommand(task, 'rm', ['-rf', '/']);
                } catch (err) {
                    caught = err instanceof Error ? err.message : String(err);
                }
            }
        }
        const tryRm = new TryRmAgent();
        tryRm.setTaskCheckpointRepo(repo);
        await tryRm.connect(makeMockEventBus() as unknown as EventBus);
        await tryRm.onTaskAssigned(makeTaskAssignedEvent());

        expect(caught).toMatch(/not on the allowlist/);
        expect(tryRm.spawnCallCount).toBe(0);
    });

    it('opt-out: KAGEOPS_TASK_CHECKPOINTS=false → no repo calls', async () => {
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'false';
        const localRepo = createInMemoryTaskCheckpointRepository();
        const spyFind = vi.spyOn(localRepo, 'findByOp');
        const spyStart = vi.spyOn(localRepo, 'recordStart');

        const local = new ExecTestAgent();
        local.setTaskCheckpointRepo(localRepo);
        await local.connect(makeMockEventBus() as unknown as EventBus);
        local.plan = [
            { command: 'npm', args: ['test'], result: { stdout: '', stderr: '', exitCode: 0 } },
        ];
        await local.onTaskAssigned(makeTaskAssignedEvent());

        expect(spyFind).not.toHaveBeenCalled();
        expect(spyStart).not.toHaveBeenCalled();
        expect(local.spawnCallCount).toBe(1);
    });

    it('non-fatal: recordStart throws → still spawns, no markCompleted', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockRejectedValue(new Error('unique violation')),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockResolvedValue(null),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        const flaky = new ExecTestAgent();
        flaky.setTaskCheckpointRepo(flakyRepo);
        await flaky.connect(makeMockEventBus() as unknown as EventBus);
        flaky.plan = [
            { command: 'npm', args: ['test'], result: { stdout: 'ok', stderr: '', exitCode: 0 } },
        ];
        await flaky.onTaskAssigned(makeTaskAssignedEvent());

        expect(flaky.spawnCallCount).toBe(1);
        expect(flakyRepo.markCompleted).not.toHaveBeenCalled();
        expect(flakyRepo.markFailed).not.toHaveBeenCalled();
    });

    it('non-fatal: findByOp throws → spawns + records normally', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockResolvedValue({
                id: 'ck-e', taskId: 't', opIndex: 0, opType: 'exec',
                status: 'in-flight', payloadJson: {}, outputJson: null,
                errorText: null, createdAt: 'now', completedAt: null,
            }),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockRejectedValue(new Error('db down')),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        const flaky = new ExecTestAgent();
        flaky.setTaskCheckpointRepo(flakyRepo);
        await flaky.connect(makeMockEventBus() as unknown as EventBus);
        flaky.plan = [
            { command: 'npm', args: ['test'], result: { stdout: 'ok', stderr: '', exitCode: 0 } },
        ];
        await flaky.onTaskAssigned(makeTaskAssignedEvent());

        expect(flaky.spawnCallCount).toBe(1);
        expect(flakyRepo.recordStart).toHaveBeenCalled();
        expect(flakyRepo.markCompleted).toHaveBeenCalled();
    });

    it('non-fatal: markCompleted throws → command result still returned to caller', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockResolvedValue({
                id: 'ck-e2', taskId: 't', opIndex: 0, opType: 'exec',
                status: 'in-flight', payloadJson: {}, outputJson: null,
                errorText: null, createdAt: 'now', completedAt: null,
            }),
            markCompleted: vi.fn().mockRejectedValue(new Error('disk full')),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockResolvedValue(null),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        let captured: ShellResult | null = null;
        class CaptureAgent extends ExecTestAgent {
            async executeTask(task: TaskInfo): Promise<void> {
                captured = await this.executeCommand(task, 'npm', ['test']);
            }
        }
        const flaky = new CaptureAgent();
        flaky.setTaskCheckpointRepo(flakyRepo);
        await flaky.connect(makeMockEventBus() as unknown as EventBus);
        flaky.plan = [
            { command: 'npm', args: ['test'], result: { stdout: 'still works', stderr: '', exitCode: 0 } },
        ];
        await flaky.onTaskAssigned(makeTaskAssignedEvent());

        expect(flaky.spawnCallCount).toBe(1);
        expect(captured).not.toBeNull();
        expect(captured!.stdout).toBe('still works');
        expect(flakyRepo.markCompleted).toHaveBeenCalled();
    });
});
