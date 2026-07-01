/**
 * Full pipeline integration tests.
 *
 * Tests the end-to-end orchestration flow using mock Sensei and EventBus.
 * Covers: project creation → phase transitions → approvals → completion.
 *
 * Does NOT require a live database or AI API keys.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';
import { createMockSensei, runProjectThroughPhases, waitForEvent } from '../helpers/pipeline-runner';
import { getMockTaskListForPhase, getMockAgentOutput, getMockReviewVerdict } from '../helpers/mock-ai-responses';

// ── Tests ─────────────────────────────────────────────

describe('Full Pipeline — Project Lifecycle', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let sensei: ReturnType<typeof createMockSensei>;

    beforeEach(() => {
        eventBus = createMockEventBus();
        sensei = createMockSensei(eventBus);
        vi.clearAllMocks();
    });

    // ── Project Creation ───────────────────────────────

    it('startProject creates a project and emits project.created', async () => {
        const eventPromise = waitForEvent(eventBus, 'project.created');

        const projectId = await sensei.startProject('Calculator CLI', 'A simple calculator CLI tool', 'low');

        expect(typeof projectId).toBe('string');
        expect(projectId.length).toBeGreaterThan(0);

        const event = await eventPromise;
        expect(event['projectId']).toBe(projectId);
    });

    it('getAllProjectsStatus returns the new project in discovery phase', async () => {
        const projectId = await sensei.startProject('Calculator CLI', 'A simple calculator CLI', 'low');

        const statuses = await sensei.getAllProjectsStatus();
        const project = statuses.find((p: any) => p.id === projectId);

        expect(project).toBeDefined();
        expect(project!.phase).toBe('discovery');
        expect(project!.status).toBe('active');
    });

    it('multiple projects can be created independently', async () => {
        const id1 = await sensei.startProject('Project Alpha', 'First project', 'low');
        const id2 = await sensei.startProject('Project Beta', 'Second project', 'medium');

        expect(id1).not.toBe(id2);

        const statuses = await sensei.getAllProjectsStatus();
        expect(statuses).toHaveLength(2);
    });

    // ── Phase Transitions ──────────────────────────────

    it('approveGate advances project from discovery to poc', async () => {
        const projectId = await sensei.startProject('Calculator CLI', 'A CLI calculator', 'low');

        await sensei.approveGate(projectId);

        const statuses = await sensei.getAllProjectsStatus();
        const project = statuses.find((p: any) => p.id === projectId);
        expect(project!.phase).toBe('poc');
    });

    it('phase.advanced event is emitted on gate approval', async () => {
        const projectId = await sensei.startProject('Calculator CLI', 'A CLI calculator', 'low');

        const eventPromise = waitForEvent(eventBus, 'phase.advanced');
        await sensei.approveGate(projectId);

        const event = await eventPromise;
        expect(event['projectId']).toBe(projectId);
        expect(event['phase']).toBe('poc');
    });

    it('project advances through all 6 phases in order', async () => {
        const projectId = await sensei.startProject('Calculator CLI', 'A CLI calculator', 'high');

        // Approve gates for all 5 transitions (discovery→poc→business-viability→design-planning→development→launch-growth)
        const transitions = await runProjectThroughPhases(sensei, eventBus, projectId, 5);

        expect(transitions).toEqual([
            'poc',
            'business-viability',
            'design-planning',
            'development',
            'launch-growth',
        ]);
    });

    it('project is marked completed after final phase approval', async () => {
        const projectId = await sensei.startProject('Calculator CLI', 'A CLI calculator', 'high');

        // Advance through all phases
        await runProjectThroughPhases(sensei, eventBus, projectId, 5);

        // Final approval moves to completed
        const completedPromise = waitForEvent(eventBus, 'project.completed');
        await sensei.approveGate(projectId);

        const event = await completedPromise;
        expect(event['projectId']).toBe(projectId);

        const statuses = await sensei.getAllProjectsStatus();
        const project = statuses.find((p: any) => p.id === projectId);
        expect(project!.status).toBe('completed');
    });

    // ── Approval Queue ─────────────────────────────────

    it('getApprovalQueue returns projects awaiting approval', async () => {
        const projectId = await sensei.startProject('Calculator CLI', 'A CLI calculator', 'low');

        // Manually set project to awaiting-approval state
        const statuses = await sensei.getAllProjectsStatus();
        const project = statuses.find((p: any) => p.id === projectId) as any;
        project.status = 'awaiting-approval';

        const queue = await sensei.getApprovalQueue();
        expect(queue.length).toBeGreaterThan(0);
        expect((queue[0] as any).id).toBe(projectId);
    });

    it('getApprovalQueue is empty when no projects await approval', async () => {
        await sensei.startProject('Calculator CLI', 'A CLI calculator', 'low');
        const queue = await sensei.getApprovalQueue();
        expect(queue).toHaveLength(0);
    });

    // ── Gate Denial ────────────────────────────────────

    it('denyGate sets project status to denied and emits phase.denied', async () => {
        const projectId = await sensei.startProject('Calculator CLI', 'A CLI calculator', 'low');

        const deniedPromise = waitForEvent(eventBus, 'phase.denied');
        await sensei.denyGate(projectId, 'Not ready for next phase');

        await deniedPromise;

        const statuses = await sensei.getAllProjectsStatus();
        const project = statuses.find((p: any) => p.id === projectId);
        expect(project!.status).toBe('denied');
    });

    it('denyGate does not advance the phase', async () => {
        const projectId = await sensei.startProject('Calculator CLI', 'A CLI calculator', 'low');
        await sensei.denyGate(projectId, 'Reason');

        const statuses = await sensei.getAllProjectsStatus();
        const project = statuses.find((p: any) => p.id === projectId);
        expect(project!.phase).toBe('discovery'); // still in discovery
    });

    // ── Sensei Chat ────────────────────────────────────

    it('handleUserMessage returns a string response', async () => {
        const response = await sensei.handleUserMessage('What projects are active?');
        expect(typeof response).toBe('string');
        expect(response.length).toBeGreaterThan(0);
    });

    // ── Mock AI Helpers ────────────────────────────────

    it('getMockTaskListForPhase returns valid JSON for all phases', () => {
        const phases: Array<'discovery' | 'poc' | 'business-viability' | 'design-planning' | 'development' | 'launch-growth'> = [
            'discovery', 'poc', 'business-viability',
            'design-planning', 'development', 'launch-growth',
        ];

        for (const phase of phases) {
            const json = getMockTaskListForPhase(phase);
            const tasks = JSON.parse(json);
            expect(Array.isArray(tasks)).toBe(true);
            expect(tasks.length).toBeGreaterThan(0);
            expect(tasks[0]).toHaveProperty('title');
            expect(tasks[0]).toHaveProperty('assignedAgent');
            expect(tasks[0]).toHaveProperty('taskType');
        }
    });

    it('getMockAgentOutput returns non-empty string for all task types', () => {
        const types = ['architecture', 'implement', 'code-review', 'general'];
        for (const type of types) {
            const output = getMockAgentOutput(type, 'Test Task');
            expect(typeof output).toBe('string');
            expect(output.length).toBeGreaterThan(0);
        }
    });

    it('getMockReviewVerdict returns a passing verdict', () => {
        const verdict = getMockReviewVerdict();
        expect(verdict.verdict).toBe('pass');
        expect(verdict.score).toBeGreaterThanOrEqual(0);
        expect(verdict.score).toBeLessThanOrEqual(10);
        expect(typeof verdict.summary).toBe('string');
    });

    // ── Multi-project isolation ────────────────────────

    it('approving one project does not affect another', async () => {
        const id1 = await sensei.startProject('Project A', 'First', 'low');
        const id2 = await sensei.startProject('Project B', 'Second', 'low');

        await sensei.approveGate(id1);

        const statuses = await sensei.getAllProjectsStatus();
        const p1 = statuses.find((p: any) => p.id === id1);
        const p2 = statuses.find((p: any) => p.id === id2);

        expect(p1!.phase).toBe('poc');
        expect(p2!.phase).toBe('discovery'); // unchanged
    });

    it('waitForEvent times out when event is never published', async () => {
        await expect(waitForEvent(eventBus, 'never.happens', 50)).rejects.toThrow('Timeout');
    });
});

describe('Mock AI Responses', () => {
    it('task lists have required fields for all phases', () => {
        const requiredFields = ['title', 'description', 'taskType', 'assignedAgent', 'priority', 'dependsOn'];
        const phases: Array<'discovery' | 'poc' | 'business-viability' | 'design-planning' | 'development' | 'launch-growth'> = [
            'discovery', 'poc', 'business-viability', 'design-planning', 'development', 'launch-growth',
        ];

        for (const phase of phases) {
            const tasks = JSON.parse(getMockTaskListForPhase(phase));
            for (const task of tasks) {
                for (const field of requiredFields) {
                    expect(task).toHaveProperty(field);
                }
            }
        }
    });

    it('discovery phase tasks use scout and blueprint agents', () => {
        const tasks = JSON.parse(getMockTaskListForPhase('discovery'));
        const agents = tasks.map((t: any) => t.assignedAgent);
        expect(agents).toContain('scout');
        expect(agents).toContain('blueprint');
    });

    it('development phase tasks use forge agent', () => {
        const tasks = JSON.parse(getMockTaskListForPhase('development'));
        const agents = tasks.map((t: any) => t.assignedAgent);
        expect(agents).toContain('forge');
    });
});
