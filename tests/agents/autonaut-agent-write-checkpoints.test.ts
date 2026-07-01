/**
 * AutonautAgent — P1-01c writeFile() checkpointing wiring.
 *
 * Exercises the cache-hit (on-disk sha256 verification + skip) and
 * cache-miss (record-start → write → mark-completed) paths added to
 * `writeFile`. Sister test file to autonaut-agent-checkpoints.test.ts
 * (which covers askAI); the same env flag (KAGEOPS_TASK_CHECKPOINTS)
 * gates both, but the cache semantics differ — writes verify against
 * the bytes on disk, not against a stored response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    AutonautAgent,
    TaskInfo,
    AgentModelConfig,
    sha256OfContent,
    readOnDiskSha256,
} from '../../src/agents/autonaut-agent';
import { EventBus, EventPayload } from '../../src/orchestrator/event-bus';
import {
    createInMemoryTaskCheckpointRepository,
    TaskCheckpointRepository,
} from '../../src/db/task-checkpoint-repo';

// ── Module mocks ──────────────────────────────────────

vi.mock('../../src/db/client', () => ({
    query: vi.fn(),
}));

import { query } from '../../src/db/client';
const mockQuery = vi.mocked(query);

// ── Fixtures ──────────────────────────────────────────

const DEFAULT_MODEL: AgentModelConfig = {
    model: 'claude/claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
};

let tempDir: string;

function freshTempDir(): string {
    const dir = path.join(os.tmpdir(), `kageops-write-cp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const TASK_ROW = {
    id: 'task-write-001',
    project_id: 'proj-001',
    title: 'Write checkpoint smoke task',
    description: 'Call writeFile a few times',
    task_type: 'general',
    phase: 'discovery',
    output_path: null,
};

function setupDbQueryForTask(repoPath: string): void {
    mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM tasks')) {
            return { rows: [TASK_ROW], rowCount: 1 };
        }
        if (typeof sql === 'string' && sql.includes('FROM projects')) {
            return { rows: [{ repo_path: repoPath }], rowCount: 1 };
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
        taskId: 'task-write-001',
        agent: 'write-checkpoint-test-agent',
        data: {},
        timestamp: new Date().toISOString(),
        ...overrides,
    };
}

/**
 * Test agent that calls writeFile() once per (filePath, content) pair
 * configured on the instance. Drives the full onTaskAssigned →
 * executeTask → writeFile flow so the `_currentTask` guard inside
 * writeFile is satisfied (same pattern used in the askAI checkpoint
 * suite).
 */
class WriteFileTestAgent extends AutonautAgent {
    public files: Array<{ relPath: string; content: string }> = [];

    constructor() {
        super(
            'write-checkpoint-test-agent',
            'tester',
            [],
            DEFAULT_MODEL,
            'You are a write-checkpoint test agent.',
        );
    }

    async executeTask(task: TaskInfo): Promise<void> {
        for (const file of this.files) {
            await this.writeFile(task.repoPath, file.relPath, file.content);
        }
    }
}

// ── Module-level helpers ─────────────────────────────

describe('sha256OfContent() + readOnDiskSha256()', () => {
    let dir: string;

    beforeEach(() => { dir = freshTempDir(); });
    afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('sha256OfContent is deterministic and matches readOnDiskSha256 of the same bytes', () => {
        const content = 'hello world\n';
        const want = sha256OfContent(content);
        const file = path.join(dir, 'a.txt');
        fs.writeFileSync(file, content, 'utf-8');
        expect(readOnDiskSha256(file)).toBe(want);
    });

    it('sha256OfContent differs when content changes', () => {
        expect(sha256OfContent('a')).not.toBe(sha256OfContent('b'));
    });

    it('readOnDiskSha256 returns null for a missing file', () => {
        expect(readOnDiskSha256(path.join(dir, 'nope.txt'))).toBeNull();
    });
});

// ── writeFile checkpoint wiring ──────────────────────

describe('AutonautAgent — writeFile() checkpoint wiring (P1-01c)', () => {
    let agent: WriteFileTestAgent;
    let eventBus: ReturnType<typeof makeMockEventBus>;
    let repo: TaskCheckpointRepository;

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'true';
        tempDir = freshTempDir();
        setupDbQueryForTask(tempDir);

        agent = new WriteFileTestAgent();
        eventBus = makeMockEventBus();
        repo = createInMemoryTaskCheckpointRepository();
        agent.setTaskCheckpointRepo(repo);
        await agent.connect(eventBus as unknown as EventBus);
    });

    afterEach(() => {
        delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('records one in-flight → completed checkpoint per writeFile call', async () => {
        agent.files = [
            { relPath: 'a.txt', content: 'A' },
            { relPath: 'sub/b.txt', content: 'B' },
            { relPath: 'sub/c.txt', content: 'C' },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const rows = await repo.listForTask('task-write-001');
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.opIndex)).toEqual([0, 1, 2]);
        expect(rows.every((r) => r.status === 'completed')).toBe(true);
        expect(rows.every((r) => r.opType === 'write')).toBe(true);

        // All files actually exist on disk.
        for (const f of agent.files) {
            expect(fs.readFileSync(path.join(tempDir, f.relPath), 'utf-8')).toBe(f.content);
        }
    });

    it('persists filePath + bytes + sha256 in payloadJson and output mirrors them', async () => {
        agent.files = [{ relPath: 'only.txt', content: 'hello checkpoint' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const [row] = await repo.listForTask('task-write-001');
        const payload = row.payloadJson as { filePath: string; bytes: number; sha256: string };
        expect(payload.filePath).toBe('only.txt');
        expect(payload.bytes).toBe(Buffer.byteLength('hello checkpoint', 'utf-8'));
        expect(payload.sha256).toBe(sha256OfContent('hello checkpoint'));

        const output = row.outputJson as { bytesWritten: number; sha256: string; securityFindings: number };
        expect(output.bytesWritten).toBe(payload.bytes);
        expect(output.sha256).toBe(payload.sha256);
        expect(typeof output.securityFindings).toBe('number');
    });

    it('skips the actual write when the on-disk sha256 matches the cached value', async () => {
        // First run — writes the file
        agent.files = [{ relPath: 'cached.txt', content: 'first-run-bytes' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());
        const filePath = path.join(tempDir, 'cached.txt');
        expect(readOnDiskSha256(filePath)).toBe(sha256OfContent('first-run-bytes'));
        const mtimeFirst = fs.statSync(filePath).mtimeMs;

        // Resume — same agent code, same content. Should serve cache hit.
        const resumed = new WriteFileTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.files = [{ relPath: 'cached.txt', content: 'first-run-bytes' }];
        await new Promise((r) => setTimeout(r, 15)); // ensure mtime would tick if rewritten
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        // File on disk is unchanged — same mtime, same bytes.
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('first-run-bytes');
        expect(fs.statSync(filePath).mtimeMs).toBe(mtimeFirst);
        // Still only one row for this op_index.
        expect(await repo.listForTask('task-write-001')).toHaveLength(1);
    });

    it('re-writes when the on-disk file was wiped between runs (sha256 mismatch ⇒ miss)', async () => {
        agent.files = [{ relPath: 'wiped.txt', content: 'survived bytes' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());
        const filePath = path.join(tempDir, 'wiped.txt');

        // Wipe the workspace between runs.
        fs.rmSync(filePath, { force: true });
        expect(fs.existsSync(filePath)).toBe(false);

        const resumed = new WriteFileTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.files = [{ relPath: 'wiped.txt', content: 'survived bytes' }];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        // File is restored from the agent's deterministic re-run.
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('survived bytes');
        // Still one row (overwrite via existing id).
        const rows = await repo.listForTask('task-write-001');
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('completed');
    });

    it('overwrites the disk and the row when the on-disk content differs (sha256 mismatch)', async () => {
        agent.files = [{ relPath: 'tamper.txt', content: 'agent original' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());
        const filePath = path.join(tempDir, 'tamper.txt');

        // Operator (or some other process) overwrote the file.
        fs.writeFileSync(filePath, 'tampered manually', 'utf-8');

        // Resume — agent re-writes its expected content; cache is treated as miss.
        const resumed = new WriteFileTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.files = [{ relPath: 'tamper.txt', content: 'agent original' }];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        expect(fs.readFileSync(filePath, 'utf-8')).toBe('agent original');
    });

    it('emits a file-write-cache-hit stream event on a verified cache hit', async () => {
        agent.files = [{ relPath: 'observe.txt', content: 'observe me' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const resumed = new WriteFileTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        const resumedBus = makeMockEventBus();
        await resumed.connect(resumedBus as unknown as EventBus);
        resumed.files = [{ relPath: 'observe.txt', content: 'observe me' }];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        const cacheHitStream = (resumedBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c) => c[0] === 'agent.stream'
                && (c[1] as { data: { type: string } }).data.type === 'file-write-cache-hit',
        );
        expect(cacheHitStream).toHaveLength(1);
        const data = (cacheHitStream[0][1] as { data: Record<string, unknown> }).data;
        expect(data).toMatchObject({
            type: 'file-write-cache-hit',
            opIndex: 0,
            path: 'observe.txt',
        });
        expect(data.bytes).toBe(Buffer.byteLength('observe me', 'utf-8'));

        // Sanity: the normal file-write stream event should NOT fire on the cache-hit run.
        const normalWriteStream = (resumedBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
            (c) => c[0] === 'agent.stream'
                && (c[1] as { data: { type: string; path?: string } }).data.type === 'file-write'
                && (c[1] as { data: { type: string; path?: string } }).data.path === 'observe.txt',
        );
        expect(normalWriteStream).toHaveLength(0);
    });

    it('writes a file-write-cache-hit row to agent_logs on a verified hit', async () => {
        agent.files = [{ relPath: 'logged.txt', content: 'log me' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        mockQuery.mockClear();
        setupDbQueryForTask(tempDir);
        const resumed = new WriteFileTestAgent();
        resumed.setTaskCheckpointRepo(repo);
        await resumed.connect(makeMockEventBus() as unknown as EventBus);
        resumed.files = [{ relPath: 'logged.txt', content: 'log me' }];
        await resumed.onTaskAssigned(makeTaskAssignedEvent());

        const insertCalls = mockQuery.mock.calls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO agent_logs'),
        );
        const hitInsert = insertCalls.find((c) => (c[1] as unknown[])[3] === 'file-write-cache-hit');
        expect(hitInsert).toBeDefined();
        const metadata = JSON.parse((hitInsert![1] as unknown[])[9] as string) as { filePath: string; bytes: number };
        expect(metadata.filePath).toBe('logged.txt');
        expect(metadata.bytes).toBe(Buffer.byteLength('log me', 'utf-8'));
    });

    it('resets op-index counter between tasks', async () => {
        agent.files = [
            { relPath: 'first/a.txt', content: 'A' },
            { relPath: 'first/b.txt', content: 'B' },
        ];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        // Second task with a different id.
        const OTHER_TASK = { ...TASK_ROW, id: 'task-write-002' };
        mockQuery.mockImplementation(async (sql: string) => {
            if (typeof sql === 'string' && sql.includes('FROM tasks')) {
                return { rows: [OTHER_TASK], rowCount: 1 };
            }
            if (typeof sql === 'string' && sql.includes('FROM projects')) {
                return { rows: [{ repo_path: tempDir }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });

        agent.files = [{ relPath: 'second/x.txt', content: 'X' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent({ taskId: 'task-write-002' }));

        const secondRows = await repo.listForTask('task-write-002');
        expect(secondRows).toHaveLength(1);
        expect(secondRows[0].opIndex).toBe(0); // fresh task → counter back to 0
    });

    it('overwrites an in-flight row at the same op-index instead of inserting twice', async () => {
        await repo.recordStart({
            taskId: 'task-write-001',
            opIndex: 0,
            opType: 'write',
            payloadJson: { filePath: 'stale.txt', bytes: 0, sha256: 'stale' },
        });

        agent.files = [{ relPath: 'in-flight.txt', content: 'after-crash' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        const rows = await repo.listForTask('task-write-001');
        expect(rows).toHaveLength(1);
        expect(rows[0].opIndex).toBe(0);
        expect(rows[0].status).toBe('completed');
        // File on disk reflects the new content.
        expect(fs.readFileSync(path.join(tempDir, 'in-flight.txt'), 'utf-8')).toBe('after-crash');
    });

    it('continues normally when recordStart throws (write still happens, no checkpoint)', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockRejectedValue(new Error('unique violation')),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockResolvedValue(null),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        const flakyAgent = new WriteFileTestAgent();
        flakyAgent.setTaskCheckpointRepo(flakyRepo);
        await flakyAgent.connect(makeMockEventBus() as unknown as EventBus);
        flakyAgent.files = [{ relPath: 'still-written.txt', content: 'flake-safe' }];

        await flakyAgent.onTaskAssigned(makeTaskAssignedEvent());

        expect(fs.readFileSync(path.join(tempDir, 'still-written.txt'), 'utf-8')).toBe('flake-safe');
        expect(flakyRepo.markCompleted).not.toHaveBeenCalled();
        expect(flakyRepo.markFailed).not.toHaveBeenCalled();
    });

    it('continues normally when findByOp throws (cache failure is non-fatal)', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockResolvedValue({
                id: 'ck-z', taskId: 't', opIndex: 0, opType: 'write',
                status: 'in-flight', payloadJson: {}, outputJson: null,
                errorText: null, createdAt: 'now', completedAt: null,
            }),
            markCompleted: vi.fn().mockResolvedValue(undefined),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockRejectedValue(new Error('db down')),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        const flakyAgent = new WriteFileTestAgent();
        flakyAgent.setTaskCheckpointRepo(flakyRepo);
        await flakyAgent.connect(makeMockEventBus() as unknown as EventBus);
        flakyAgent.files = [{ relPath: 'find-fail.txt', content: 'find-flake' }];

        await flakyAgent.onTaskAssigned(makeTaskAssignedEvent());

        expect(fs.readFileSync(path.join(tempDir, 'find-fail.txt'), 'utf-8')).toBe('find-flake');
        // The write path still records the checkpoint even when the read failed.
        expect(flakyRepo.recordStart).toHaveBeenCalled();
        expect(flakyRepo.markCompleted).toHaveBeenCalled();
    });

    it('continues normally when markCompleted throws (file is written, log warns)', async () => {
        const flakyRepo: TaskCheckpointRepository = {
            recordStart: vi.fn().mockResolvedValue({
                id: 'ck-q', taskId: 't', opIndex: 0, opType: 'write',
                status: 'in-flight', payloadJson: {}, outputJson: null,
                errorText: null, createdAt: 'now', completedAt: null,
            }),
            markCompleted: vi.fn().mockRejectedValue(new Error('disk full')),
            markFailed: vi.fn().mockResolvedValue(undefined),
            findByOp: vi.fn().mockResolvedValue(null),
            listForTask: vi.fn().mockResolvedValue([]),
            deleteForTask: vi.fn().mockResolvedValue(undefined),
        };
        const flakyAgent = new WriteFileTestAgent();
        flakyAgent.setTaskCheckpointRepo(flakyRepo);
        await flakyAgent.connect(makeMockEventBus() as unknown as EventBus);
        flakyAgent.files = [{ relPath: 'mark-fail.txt', content: 'mark-flake' }];

        await flakyAgent.onTaskAssigned(makeTaskAssignedEvent());

        expect(fs.readFileSync(path.join(tempDir, 'mark-fail.txt'), 'utf-8')).toBe('mark-flake');
        expect(flakyRepo.markCompleted).toHaveBeenCalled();
    });

    it('rejects path traversal even with checkpoints enabled (security comes first)', async () => {
        agent.files = [{ relPath: '../../escape.txt', content: 'evil' }];
        await agent.onTaskAssigned(makeTaskAssignedEvent());

        // The task should have failed (path traversal throws); no row was recorded
        // because the validatePath check happens before any checkpoint write.
        const rows = await repo.listForTask('task-write-001');
        expect(rows).toHaveLength(0);
    });
});

// ── Opt-out paths ────────────────────────────────────

describe('AutonautAgent — writeFile() with checkpoints disabled', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Checkpoints are ON by default now — the kill-switch is the
        // explicit `false`, so the disabled path must set it.
        process.env['KAGEOPS_TASK_CHECKPOINTS'] = 'false';
        tempDir = freshTempDir();
        setupDbQueryForTask(tempDir);
    });

    afterEach(() => {
        delete process.env['KAGEOPS_TASK_CHECKPOINTS'];
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('does not touch the repo when KAGEOPS_TASK_CHECKPOINTS=false', async () => {
        const repo = createInMemoryTaskCheckpointRepository();
        const spyFind = vi.spyOn(repo, 'findByOp');
        const spyStart = vi.spyOn(repo, 'recordStart');

        const agent = new WriteFileTestAgent();
        agent.setTaskCheckpointRepo(repo);
        await agent.connect(makeMockEventBus() as unknown as EventBus);
        agent.files = [{ relPath: 'no-checkpoint.txt', content: 'ok' }];

        await agent.onTaskAssigned(makeTaskAssignedEvent());

        expect(spyFind).not.toHaveBeenCalled();
        expect(spyStart).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(tempDir, 'no-checkpoint.txt'), 'utf-8')).toBe('ok');
    });
});
