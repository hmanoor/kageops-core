/**
 * Vigil review integration tests
 *
 * Tests the Sensei ↔ Vigil review loop:
 * 1. Sensei creates review tasks after reviewable tasks complete
 * 2. Vigil publishes review.passed/review.rejected events
 * 3. Sensei handles review results (quality score update, re-assignment)
 * 4. Review loop terminates after MAX_REVIEW_ROUNDS
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';
import { parseReviewVerdict } from '../../src/agents/specialists/vigil';

// ── Mock setup ───────────────────────────────────────────────────────────────

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const initDatabaseFn = vi.fn(async () => undefined);
    const testConnectionFn = vi.fn(async () => true);
    const closePoolFn = vi.fn(async () => undefined);
    const getPoolFn = vi.fn(() => ({ query: queryFn, end: vi.fn() }));
    const reset = (): void => {
        queryFn.mockClear();
        getOneFn.mockClear();
        getManyFn.mockClear();
        initDatabaseFn.mockClear();
        testConnectionFn.mockClear();
        closePoolFn.mockClear();
        getPoolFn.mockClear();
    };
    return {
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        initDatabase: initDatabaseFn,
        testConnection: testConnectionFn,
        closePool: closePoolFn,
        getPool: getPoolFn,
        reset,
        module: () => ({
            query: queryFn,
            getOne: getOneFn,
            getMany: getManyFn,
            initDatabase: initDatabaseFn,
            testConnection: testConnectionFn,
            closePool: closePoolFn,
            getPool: getPoolFn,
        }),
    };
});

vi.mock('../../src/db/client', () => mockDb.module());

vi.mock('../../src/comms/comms-sender', () => ({
    CommsSender: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        enqueue: vi.fn(async () => 'msg-1'),
        processPending: vi.fn(async () => 0),
        getChannels: vi.fn(() => []),
    })),
}));

vi.mock('../../src/workspace/workspace-manager', () => ({
    WorkspaceManager: vi.fn(() => ({
        createProject: vi.fn(async () => '/tmp/projects/test'),
    })),
}));

// Import after mocks
import { Sensei } from '../../src/orchestrator/sensei';
import type { EventBus } from '../../src/orchestrator/event-bus';

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_TASK_JSON = JSON.stringify([
    { title: 'Task', description: 'A task', taskType: 'research', assignedAgent: 'scout', priority: 5, dependsOn: [] },
]);

function makeSendPrompt(): ReturnType<typeof vi.fn> {
    return vi.fn(async () => VALID_TASK_JSON);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Vigil review integration', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let sendPrompt: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
        sendPrompt = makeSendPrompt();
    });

    function makeSensei(): Sensei {
        return new Sensei({ sendPrompt }, eventBus as unknown as EventBus);
    }

    // ── isReviewableTask (via handleEvent) ───────────────────────────────────

    describe('review task creation', () => {
        it('creates a code-review task when an implement task completes in development phase', async () => {
            const sensei = makeSensei();
            await sensei.start();

            // 1. Task lookup: implement task in development phase
            mockDb.getOne.mockResolvedValueOnce({
                task_type: 'implement', quality_score: null, phase: 'development',
            });
            // 2. Matrix: current score
            mockDb.getOne.mockResolvedValueOnce({ score: 6.0 });
            // 3. Matrix: UPDATE
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // 4. Review count check
            mockDb.getOne.mockResolvedValueOnce({ review_count: '0' });
            // 5. INSERT review task
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'review-task-1' }], rowCount: 1 });
            // 6. routeTask: load review task
            mockDb.getOne.mockResolvedValueOnce({
                id: 'review-task-1', projectId: 'proj-review', title: 'Code review',
                description: 'Review', taskType: 'code-review', phase: 'development',
                assignedAgent: 'vigil', status: 'pending', priority: 5, dependsOn: [],
            });
            // 7. routeTask: assignTask UPDATE
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            await sensei.handleEvent({
                channel: 'task.completed',
                projectId: 'proj-review',
                taskId: 'task-impl-1',
                agent: 'forge',
                timestamp: new Date().toISOString(),
                data: {},
            });

            // Should have created a review task
            const insertCall = mockDb.query.mock.calls.find(
                ([sql]) => (sql as string).includes('INSERT INTO tasks') && (sql as string).includes('code-review')
            );
            expect(insertCall).toBeDefined();

            // Should have published review.requested
            const reviewEvent = eventBus.publishedEvents.find(
                (e) => e.channel === 'review.requested'
            );
            expect(reviewEvent).toBeDefined();
        });

        it('does not create a review task for non-reviewable task types', async () => {
            const sensei = makeSensei();
            await sensei.start();

            // research task in discovery phase — not reviewable
            mockDb.getOne.mockResolvedValueOnce({
                task_type: 'research', quality_score: null, phase: 'discovery',
            });
            mockDb.getOne.mockResolvedValueOnce({ score: 6.0 });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // checkGate: project
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-noreview', phase: 'discovery', trust_level: 'low',
                autonomous_after_design: false, status: 'active',
            });
            // allPhaseTasksComplete
            mockDb.getOne.mockResolvedValueOnce({ total: '3', completed: '2' });

            await sensei.handleEvent({
                channel: 'task.completed',
                projectId: 'proj-noreview',
                taskId: 'task-research',
                agent: 'scout',
                timestamp: new Date().toISOString(),
                data: {},
            });

            // No review.requested event should be published
            const reviewEvent = eventBus.publishedEvents.find(
                (e) => e.channel === 'review.requested'
            );
            expect(reviewEvent).toBeUndefined();
        });

        it('skips review when max review rounds reached', async () => {
            const sensei = makeSensei();
            await sensei.start();

            mockDb.getOne.mockResolvedValueOnce({
                task_type: 'implement', quality_score: null, phase: 'development',
            });
            mockDb.getOne.mockResolvedValueOnce({ score: 6.0 });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // Review count = 2 (max)
            mockDb.getOne.mockResolvedValueOnce({ review_count: '2' });
            // checkGate: project (falls through to phase gate check)
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-maxrev', phase: 'development', trust_level: 'low',
                autonomous_after_design: false, status: 'active',
            });
            mockDb.getOne.mockResolvedValueOnce({ total: '5', completed: '4' });

            await sensei.handleEvent({
                channel: 'task.completed',
                projectId: 'proj-maxrev',
                taskId: 'task-impl-max',
                agent: 'forge',
                timestamp: new Date().toISOString(),
                data: {},
            });

            // No review.requested event
            const reviewEvent = eventBus.publishedEvents.find(
                (e) => e.channel === 'review.requested'
            );
            expect(reviewEvent).toBeUndefined();
        });
    });

    // ── review.passed handler ────────────────────────────────────────────────

    describe('onReviewPassed', () => {
        it('updates quality score on the original task', async () => {
            const sensei = makeSensei();
            await sensei.start();

            // getOne: review task description (to find original task ID)
            mockDb.getOne.mockResolvedValueOnce({
                description: 'Review the output of implement task. [review-of:task-orig-1]',
            });
            // UPDATE quality_score
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // checkGate: project
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-pass', phase: 'development', trust_level: 'low',
                autonomous_after_design: false, status: 'active',
            });
            mockDb.getOne.mockResolvedValueOnce({ total: '5', completed: '4' });

            await sensei.handleEvent({
                channel: 'review.passed',
                projectId: 'proj-pass',
                taskId: 'review-task-1',
                agent: 'vigil',
                timestamp: new Date().toISOString(),
                data: { qualityScore: 8, summary: 'Clean code, well tested' },
            });

            const updateCall = mockDb.query.mock.calls.find(
                ([sql]) => (sql as string).includes('UPDATE tasks SET quality_score')
            );
            expect(updateCall).toBeDefined();
            expect(updateCall![1]).toContain(8); // quality score
            expect(updateCall![1]).toContain('task-orig-1'); // original task ID
        });

        it('checks phase gate after review passes', async () => {
            const sensei = makeSensei();
            await sensei.start();

            mockDb.getOne.mockResolvedValueOnce({
                description: 'Review. [review-of:task-orig-2]',
            });
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // checkGate
            mockDb.getOne.mockResolvedValueOnce({
                id: 'proj-gate', phase: 'development', trust_level: 'low',
                autonomous_after_design: false, status: 'active',
            });
            mockDb.getOne.mockResolvedValueOnce({ total: '5', completed: '4' });

            await sensei.handleEvent({
                channel: 'review.passed',
                projectId: 'proj-gate',
                taskId: 'review-task-2',
                agent: 'vigil',
                timestamp: new Date().toISOString(),
                data: { qualityScore: 7 },
            });

            // checkGate should have queried the project
            const projectQuery = mockDb.getOne.mock.calls.find(
                ([sql]) => (sql as string).includes('FROM projects WHERE id')
            );
            expect(projectQuery).toBeDefined();
        });
    });

    // ── review.rejected handler ──────────────────────────────────────────────

    describe('onReviewRejected', () => {
        it('re-assigns the original task with review feedback appended', async () => {
            const sensei = makeSensei();
            await sensei.start();

            // getOne: review task description
            mockDb.getOne.mockResolvedValueOnce({
                description: 'Review the code. [review-of:task-orig-3]',
            });
            // UPDATE original task (set pending + append feedback)
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
            // routeTask: load original task
            mockDb.getOne.mockResolvedValueOnce({
                id: 'task-orig-3', projectId: 'proj-reject', title: 'Implement feature',
                description: 'desc', taskType: 'implement', phase: 'development',
                assignedAgent: 'forge', status: 'pending', priority: 5, dependsOn: [],
            });
            // routeTask: assignTask UPDATE
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            await sensei.handleEvent({
                channel: 'review.rejected',
                projectId: 'proj-reject',
                taskId: 'review-task-3',
                agent: 'vigil',
                timestamp: new Date().toISOString(),
                data: { qualityScore: 3, summary: 'Missing error handling' },
            });

            const updateCall = mockDb.query.mock.calls.find(
                ([sql]) => (sql as string).includes('UPDATE tasks SET status') && (sql as string).includes('pending')
            );
            expect(updateCall).toBeDefined();
            // Feedback should be appended
            expect(updateCall![1][0]).toContain('REVIEW FEEDBACK');
            expect(updateCall![1][0]).toContain('Missing error handling');
        });
    });
});

// ── parseReviewVerdict tests ─────────────────────────────────────────────────

describe('parseReviewVerdict()', () => {
    it('parses a structured verdict block', () => {
        const output = [
            'Some review content...',
            '',
            '--- REVIEW VERDICT ---',
            'QUALITY_SCORE: 8',
            'VERDICT: PASSED',
            'CRITICAL_COUNT: 0',
            'SUMMARY: Clean code with good test coverage',
            '--- END VERDICT ---',
        ].join('\n');

        const verdict = parseReviewVerdict(output);

        expect(verdict.qualityScore).toBe(8);
        expect(verdict.passed).toBe(true);
        expect(verdict.criticalCount).toBe(0);
        expect(verdict.summary).toBe('Clean code with good test coverage');
    });

    it('parses a rejected verdict', () => {
        const output = [
            '--- REVIEW VERDICT ---',
            'QUALITY_SCORE: 3',
            'VERDICT: REJECTED',
            'CRITICAL_COUNT: 2',
            'SUMMARY: SQL injection vulnerabilities found',
            '--- END VERDICT ---',
        ].join('\n');

        const verdict = parseReviewVerdict(output);

        expect(verdict.qualityScore).toBe(3);
        expect(verdict.passed).toBe(false);
        expect(verdict.criticalCount).toBe(2);
    });

    it('falls back to loose regex when no verdict block present', () => {
        const output = 'Overall quality score: 7\nGood code, minor issues.';

        const verdict = parseReviewVerdict(output);

        expect(verdict.qualityScore).toBe(7);
        expect(verdict.passed).toBe(true); // >= 6 and no critical
    });

    it('falls back to REJECTED when quality score < 6 in unstructured output', () => {
        const output = 'Quality score: 4\nSeveral issues found.';

        const verdict = parseReviewVerdict(output);

        expect(verdict.qualityScore).toBe(4);
        expect(verdict.passed).toBe(false);
    });

    it('falls back to REJECTED when critical keyword found in unstructured output', () => {
        const output = 'Quality score: 7\nCRITICAL: SQL injection in user input.';

        const verdict = parseReviewVerdict(output);

        expect(verdict.passed).toBe(false);
        expect(verdict.criticalCount).toBe(1);
    });

    it('defaults to score 5 and passed when no score found', () => {
        const output = 'The code looks okay overall.';

        const verdict = parseReviewVerdict(output);

        expect(verdict.qualityScore).toBe(5);
        expect(verdict.passed).toBe(false); // 5 < 6
    });

    it('clamps quality score to 1-10 range', () => {
        const output = [
            '--- REVIEW VERDICT ---',
            'QUALITY_SCORE: 15',
            'VERDICT: PASSED',
            'CRITICAL_COUNT: 0',
            'SUMMARY: Excellent',
            '--- END VERDICT ---',
        ].join('\n');

        const verdict = parseReviewVerdict(output);
        expect(verdict.qualityScore).toBe(10);
    });
});
