/**
 * PhaseGateManager behavioral tests
 *
 * Tests gate checking, approval/deny flows, phase advancement,
 * trust-level logic, and autonomous-after-design overrides.
 * All db/client calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── DB mock must be hoisted before any source import ─────────────────────────

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

// ── Imports after mock setup ─────────────────────────────────────────────────

import { PhaseGateManager, type ProjectPhaseInfo } from '../../src/orchestrator/phase-gates';
import type { Phase } from '../../src/orchestrator/task-decomposer';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildProject(overrides: Partial<ProjectPhaseInfo> = {}): ProjectPhaseInfo {
    return {
        id: 'proj-001',
        phase: 'discovery',
        trust_level: 'medium',
        autonomous_after_design: false,
        status: 'active',
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PhaseGateManager', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;

    beforeEach(() => {
        mockDb.reset();
        eventBus = createMockEventBus();
    });

    // ── checkGate() ───────────────────────────────────────────────────────────

    describe('checkGate()', () => {

        // F-368: short-circuit on awaiting-input — reopened-but-no-new-work
        it('short-circuits with alreadyComplete=true when status is awaiting-input', async () => {
            mockDb.getOne.mockResolvedValueOnce(
                buildProject({ status: 'awaiting-input', phase: 'launch-growth' as never }),
            );
            // Crucial: task-count query should NOT be called — early-return.

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.alreadyComplete).toBe(true);
            expect(gate.requiresApproval).toBe(false);
            expect(gate.canAutoAdvance).toBe(false);
            expect(gate.allTasksComplete).toBe(true);
            // getOne was called exactly once (project read), not twice (task count)
            expect(mockDb.getOne).toHaveBeenCalledTimes(1);
        });

        // 1. allTasksComplete: true when all phase tasks completed
        it('returns allTasksComplete true when all tasks in the phase are completed', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject())   // project query
                .mockResolvedValueOnce({ total: '4', done: '4' }); // task count query

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.allTasksComplete).toBe(true);
        });

        // 1b. allTasksComplete true when tasks reached terminal state (completed OR failed)
        //     A 'failed' task (retries exhausted) must NOT block phase advancement —
        //     otherwise headless runs hang indefinitely waiting on a task that will never finish.
        it('treats failed tasks as done so they do not block phase advancement', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject())
                // 3 of 5 completed + 2 failed → total=5, done=5
                .mockResolvedValueOnce({ total: '5', done: '5' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.allTasksComplete).toBe(true);
        });

        // 2. allTasksComplete: false when tasks remain
        it('returns allTasksComplete false when some tasks are still pending', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject())
                .mockResolvedValueOnce({ total: '4', done: '2' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.allTasksComplete).toBe(false);
        });

        it('returns allTasksComplete false when there are zero tasks in the phase', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject())
                .mockResolvedValueOnce({ total: '0', done: '0' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.allTasksComplete).toBe(false);
        });

        // 3. requiresApproval: true for trust level 'low'
        it('returns requiresApproval true for trust level low', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ trust_level: 'low' }))
                .mockResolvedValueOnce({ total: '2', done: '2' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.requiresApproval).toBe(true);
            expect(gate.trustLevel).toBe('low');
        });

        // 4. requiresApproval: true for trust level 'medium'
        it('returns requiresApproval true for trust level medium', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ trust_level: 'medium' }))
                .mockResolvedValueOnce({ total: '3', done: '3' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.requiresApproval).toBe(true);
            expect(gate.trustLevel).toBe('medium');
        });

        // 5. requiresApproval: false for trust level 'high'
        it('returns requiresApproval false for trust level high', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ trust_level: 'high' }))
                .mockResolvedValueOnce({ total: '2', done: '2' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.requiresApproval).toBe(false);
        });

        // 6. requiresApproval: false for post-design phases when autonomous_after_design=true
        it('does not require approval for development phase when autonomous_after_design is true', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(
                    buildProject({
                        phase: 'development',
                        trust_level: 'low',
                        autonomous_after_design: true,
                    })
                )
                .mockResolvedValueOnce({ total: '5', done: '5' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.requiresApproval).toBe(false);
        });

        it('does not require approval for launch-growth phase when autonomous_after_design is true', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(
                    buildProject({
                        phase: 'launch-growth',
                        trust_level: 'medium',
                        autonomous_after_design: true,
                    })
                )
                .mockResolvedValueOnce({ total: '3', done: '3' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.requiresApproval).toBe(false);
        });

        it('still requires approval for pre-design phases even when autonomous_after_design is true', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(
                    buildProject({
                        phase: 'discovery',
                        trust_level: 'low',
                        autonomous_after_design: true,
                    })
                )
                .mockResolvedValueOnce({ total: '2', done: '2' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.requiresApproval).toBe(true);
        });

        // 7. canAutoAdvance: true only when allTasksComplete && !requiresApproval
        it('sets canAutoAdvance true only when all tasks complete and no approval required', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ trust_level: 'high' }))
                .mockResolvedValueOnce({ total: '3', done: '3' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.canAutoAdvance).toBe(true);
        });

        it('sets canAutoAdvance false when tasks are incomplete even if no approval required', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ trust_level: 'high' }))
                .mockResolvedValueOnce({ total: '3', done: '1' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.canAutoAdvance).toBe(false);
        });

        it('sets canAutoAdvance false when tasks complete but approval is required', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ trust_level: 'low' }))
                .mockResolvedValueOnce({ total: '3', done: '3' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.canAutoAdvance).toBe(false);
        });

        // 14. throws when project not found
        it('throws when the project is not found in DB', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const manager = new PhaseGateManager(eventBus as never);

            await expect(manager.checkGate('ghost-project')).rejects.toThrow(
                'Project not found: ghost-project'
            );
        });

        it('returns the correct currentPhase from the project record', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ phase: 'poc' }))
                .mockResolvedValueOnce({ total: '1', done: '0' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.currentPhase).toBe('poc');
            expect(gate.projectId).toBe('proj-001');
        });

        // P1-09b (2026-05-25): revision-only iteration must not auto-advance
        // to launch-growth. Pre-fix the gate happily approved development on
        // a /add-requirement-driven iteration and Sensei decomposed 6 NEW
        // tasks under launch-growth that bypassed the staging/diff-card
        // flow. Now the gate parks the project in awaiting-input and
        // surfaces alreadyComplete=true so callers no-op.

        it('parks in awaiting-input and suppresses canAutoAdvance when every completed task in development is a revision', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({
                    phase: 'development',
                    trust_level: 'high',
                    autonomous_after_design: true,
                }))
                .mockResolvedValueOnce({ total: '1', done: '1' })   // allPhaseTasksComplete
                .mockResolvedValueOnce({ total: '1', revisions: '1' }); // allCompletedTasksAreRevisions

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.canAutoAdvance).toBe(false);
            expect(gate.alreadyComplete).toBe(true);
            expect(gate.allTasksComplete).toBe(true);

            // status UPDATE was issued to park the project.
            const updateCalls = mockDb.query.mock.calls.filter((c: readonly unknown[]) =>
                typeof c[0] === 'string' && c[0].includes(`SET status = 'awaiting-input'`),
            );
            expect(updateCalls).toHaveLength(1);
        });

        it('still advances normally when development tasks are mixed revision + non-revision', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({
                    phase: 'development',
                    trust_level: 'high',
                    autonomous_after_design: true,
                }))
                .mockResolvedValueOnce({ total: '3', done: '3' })
                .mockResolvedValueOnce({ total: '3', revisions: '1' });

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.canAutoAdvance).toBe(true);
            expect(gate.alreadyComplete).toBeUndefined();

            const updateCalls = mockDb.query.mock.calls.filter((c: readonly unknown[]) =>
                typeof c[0] === 'string' && c[0].includes(`SET status = 'awaiting-input'`),
            );
            expect(updateCalls).toHaveLength(0);
        });

        it('does not run the revision-only check outside the development phase', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({
                    phase: 'launch-growth',
                    trust_level: 'high',
                    autonomous_after_design: true,
                }))
                .mockResolvedValueOnce({ total: '2', done: '2' });
            // Crucially: no 3rd getOne mock — the revision-only query must NOT fire.

            const manager = new PhaseGateManager(eventBus as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.canAutoAdvance).toBe(true);
            expect(mockDb.getOne).toHaveBeenCalledTimes(2);
        });

        // P1-09c (2026-05-25): when KAGEOPS_FEATURE_REVISIONS=true and the
        // iteration is revision-only, the workspace is intentionally
        // pre-Accept (staged). AcceptanceGate against that workspace
        // guaranteed-fails text-contains rules synthesised from the appended
        // /add-requirement text. Skip the gate; the Accept handler is
        // responsible for re-running acceptance post-Accept.

        it('skips AcceptanceGate.verify when KAGEOPS_FEATURE_REVISIONS=true on a revision-only iteration', async () => {
            const verifySpy = vi.fn();
            const mockAcceptanceGate = { verify: verifySpy } as never;

            mockDb.getOne
                .mockResolvedValueOnce(buildProject({
                    phase: 'development',
                    trust_level: 'high',
                    autonomous_after_design: true,
                    description: 'Some brief with required #app-root and visible text "hello".',
                } as never))
                .mockResolvedValueOnce({ total: '1', done: '1' })
                .mockResolvedValueOnce({ total: '1', revisions: '1' });

            const prev = process.env['KAGEOPS_FEATURE_REVISIONS'];
            process.env['KAGEOPS_FEATURE_REVISIONS'] = 'true';
            try {
                const manager = new PhaseGateManager(eventBus as never, undefined, mockAcceptanceGate);
                const gate = await manager.checkGate('proj-001');

                expect(verifySpy).not.toHaveBeenCalled();
                expect(gate.acceptancePassed).toBeUndefined();
                expect(gate.canAutoAdvance).toBe(false);  // still parked via P1-09b
                expect(gate.alreadyComplete).toBe(true);
            } finally {
                if (prev === undefined) delete process.env['KAGEOPS_FEATURE_REVISIONS'];
                else process.env['KAGEOPS_FEATURE_REVISIONS'] = prev;
            }
        });

        it('still runs AcceptanceGate.verify on a revision-only iteration when the staging flag is OFF (direct-write path)', async () => {
            // Acceptance is needed on the flag-off path: the revision wrote
            // directly to the workspace, so the artifact CAN be validated.
            const verifySpy = vi.fn().mockResolvedValue({
                passed: true,
                skipped: false,
                violations: [],
            });
            const mockAcceptanceGate = { verify: verifySpy } as never;

            mockDb.getOne
                .mockResolvedValueOnce(buildProject({
                    phase: 'development',
                    trust_level: 'high',
                    autonomous_after_design: true,
                    description: 'Some brief.',
                } as never))
                .mockResolvedValueOnce({ total: '1', done: '1' })
                .mockResolvedValueOnce({ total: '1', revisions: '1' });

            const prev = process.env['KAGEOPS_FEATURE_REVISIONS'];
            delete process.env['KAGEOPS_FEATURE_REVISIONS'];
            try {
                const manager = new PhaseGateManager(eventBus as never, undefined, mockAcceptanceGate);
                await manager.checkGate('proj-001');

                expect(verifySpy).toHaveBeenCalledTimes(1);
            } finally {
                if (prev !== undefined) process.env['KAGEOPS_FEATURE_REVISIONS'] = prev;
            }
        });
    });

    // ── requestApproval() ─────────────────────────────────────────────────────

    describe('requestApproval()', () => {

        // 8. Updates project status to 'awaiting-approval'
        it('sets project status to awaiting-approval in the database', async () => {
            mockDb.getOne.mockResolvedValueOnce(
                buildProject({ phase: 'poc', trust_level: 'low' })
            );
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            await manager.requestApproval('proj-001');

            const updateCall = mockDb.query.mock.calls.find(
                ([sql]: [string]) => sql.includes("'awaiting-approval'")
            );
            expect(updateCall).toBeDefined();
            expect(updateCall![1]).toEqual(['proj-001']);
        });

        // 9. Publishes approval.required event
        it('publishes an approval.required event with current phase and trust level', async () => {
            mockDb.getOne.mockResolvedValueOnce(
                buildProject({ phase: 'design-planning', trust_level: 'medium' })
            );
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            await manager.requestApproval('proj-001');

            expect(eventBus.publish).toHaveBeenCalledOnce();
            const [channel, payload] = eventBus.publish.mock.calls[0];
            expect(channel).toBe('approval.required');
            expect(payload).toMatchObject({
                projectId: 'proj-001',
                data: expect.objectContaining({
                    currentPhase: 'design-planning',
                    trustLevel: 'medium',
                }),
            });
        });

        it('throws when project is not found', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const manager = new PhaseGateManager(eventBus as never);

            await expect(manager.requestApproval('missing-proj')).rejects.toThrow(
                'Project not found: missing-proj'
            );
        });
    });

    // ── approveGate() ─────────────────────────────────────────────────────────

    describe('approveGate()', () => {

        // 10. Advances project to next phase via UPDATE
        it('advances project phase and sets status to active for a mid-sequence phase', async () => {
            mockDb.getOne.mockResolvedValueOnce(
                buildProject({ phase: 'discovery', status: 'awaiting-approval' })
            );
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            const next = await manager.approveGate('proj-001');

            expect(next).toBe('poc');

            const updateCall = mockDb.query.mock.calls.find(
                ([sql]: [string]) =>
                    sql.includes("status = 'active'") && sql.includes('phase = $1')
            );
            expect(updateCall).toBeDefined();
            expect(updateCall![1]).toEqual(['poc', 'proj-001', 'discovery']);
        });

        it('advances through the full phase sequence correctly', async () => {
            const phases: Phase[] = [
                'discovery',
                'poc',
                'business-viability',
                'design-planning',
                'development',
            ];
            const expectedNext: Phase[] = [
                'poc',
                'business-viability',
                'design-planning',
                'development',
                'launch-growth',
            ];

            for (let i = 0; i < phases.length; i++) {
                mockDb.reset();
                eventBus = createMockEventBus();
                mockDb.getOne.mockResolvedValueOnce(buildProject({ phase: phases[i] }));
                mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

                const manager = new PhaseGateManager(eventBus as never);
                const next = await manager.approveGate('proj-001');

                expect(next).toBe(expectedNext[i]);
            }
        });

        // 11. Returns null and marks project 'completed' at last phase
        it('marks project completed and returns null when approving the last phase', async () => {
            mockDb.getOne.mockResolvedValueOnce(
                buildProject({ phase: 'launch-growth', status: 'awaiting-approval' })
            );
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            const next = await manager.approveGate('proj-001');

            expect(next).toBeNull();

            const updateCall = mockDb.query.mock.calls.find(
                ([sql]: [string]) => sql.includes("'completed'")
            );
            expect(updateCall).toBeDefined();
            expect(updateCall![1]).toEqual(['proj-001']);
        });

        // 12. Publishes approval.granted event
        it('publishes an approval.granted event on phase advance', async () => {
            mockDb.getOne.mockResolvedValueOnce(buildProject({ phase: 'poc' }));
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            await manager.approveGate('proj-001');

            expect(eventBus.publish).toHaveBeenCalledOnce();
            const [channel, payload] = eventBus.publish.mock.calls[0];
            expect(channel).toBe('approval.granted');
            expect(payload).toMatchObject({
                projectId: 'proj-001',
                agent: 'human',
            });
        });

        it('publishes approval.granted with nextPhase null when project is completed', async () => {
            mockDb.getOne.mockResolvedValueOnce(buildProject({ phase: 'launch-growth' }));
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            await manager.approveGate('proj-001');

            const [, payload] = eventBus.publish.mock.calls[0];
            expect(payload).toMatchObject({
                data: expect.objectContaining({ nextPhase: null }),
            });
        });

        it('throws when project is not found', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const manager = new PhaseGateManager(eventBus as never);

            await expect(manager.approveGate('ghost-proj')).rejects.toThrow(
                'Project not found: ghost-proj'
            );
        });
    });

    // ── denyGate() ────────────────────────────────────────────────────────────

    describe('denyGate()', () => {

        // 13. Keeps project in current phase, publishes approval.denied
        it('keeps project in active status and publishes approval.denied event', async () => {
            mockDb.getOne.mockResolvedValueOnce(
                buildProject({ phase: 'business-viability', status: 'awaiting-approval' })
            );
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            await manager.denyGate('proj-001', 'Needs more research');

            // Status reset to active (not advanced)
            const updateCall = mockDb.query.mock.calls.find(
                ([sql]: [string]) => sql.includes("'active'")
            );
            expect(updateCall).toBeDefined();
            expect(updateCall![1]).toEqual(['proj-001']);

            // Event published
            expect(eventBus.publish).toHaveBeenCalledOnce();
            const [channel, payload] = eventBus.publish.mock.calls[0];
            expect(channel).toBe('approval.denied');
            expect(payload).toMatchObject({
                projectId: 'proj-001',
                data: expect.objectContaining({
                    currentPhase: 'business-viability',
                    reason: 'Needs more research',
                }),
            });
        });

        it('uses a default reason message when none is provided', async () => {
            mockDb.getOne.mockResolvedValueOnce(buildProject({ phase: 'discovery' }));
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            await manager.denyGate('proj-001');

            const [, payload] = eventBus.publish.mock.calls[0];
            expect((payload as { data: { reason: string } }).data.reason).toMatch(
                /denied by human/i
            );
        });

        it('does not advance the phase after a denial', async () => {
            mockDb.getOne.mockResolvedValueOnce(buildProject({ phase: 'poc' }));
            mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never);
            await manager.denyGate('proj-001');

            // No UPDATE that sets a new phase value should have been issued
            const phaseAdvanceCall = mockDb.query.mock.calls.find(
                ([sql]: [string]) => sql.includes('phase = $1')
            );
            expect(phaseAdvanceCall).toBeUndefined();
        });

        it('throws when project is not found', async () => {
            mockDb.getOne.mockResolvedValueOnce(null);

            const manager = new PhaseGateManager(eventBus as never);

            await expect(manager.denyGate('ghost-proj')).rejects.toThrow(
                'Project not found: ghost-proj'
            );
        });
    });

    // P2-03: build verification surface on gateStatus
    describe('checkGate() — P2-03 build failure surface', () => {
        function makeBuildVerificationGate(result: {
            passed: boolean;
            failedStep?: 'install' | 'build' | 'test';
            stderr?: string;
            stdout?: string;
        }): { verify: ReturnType<typeof vi.fn> } {
            const buildResult = {
                projectId: 'proj-001',
                passed: result.passed,
                failedStep: result.failedStep ?? null,
                steps: result.failedStep !== undefined
                    ? [
                          {
                              step: result.failedStep,
                              passed: result.passed,
                              stdout: result.stdout ?? '',
                              stderr: result.stderr ?? '',
                              durationMs: 100,
                          },
                      ]
                    : [],
            };
            return { verify: vi.fn(async () => buildResult) };
        }

        it('surfaces buildFailedStep + buildFailedStderr on gateStatus when build fails', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ phase: 'development', repo_path: '/tmp/p' }))
                .mockResolvedValueOnce({ total: '3', done: '3' });
            // revision-only iteration check (allCompletedTasksAreRevisions helper)
            mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

            const bvg = makeBuildVerificationGate({
                passed: false,
                failedStep: 'build',
                stderr: 'TS2304: Cannot find name "foo".',
            });
            const manager = new PhaseGateManager(eventBus as never, bvg as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.buildVerificationPassed).toBe(false);
            expect(gate.buildFailedStep).toBe('build');
            expect(gate.buildFailedStderr).toContain('TS2304');
            expect(gate.canAutoAdvance).toBe(false);
        });

        it('truncates buildFailedStderr to 4000 chars when stderr is very long', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ phase: 'development', repo_path: '/tmp/p' }))
                .mockResolvedValueOnce({ total: '1', done: '1' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

            const bigStderr = 'A'.repeat(8000);
            const bvg = makeBuildVerificationGate({
                passed: false,
                failedStep: 'test',
                stderr: bigStderr,
            });
            const manager = new PhaseGateManager(eventBus as never, bvg as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.buildFailedStderr).toBeDefined();
            expect(gate.buildFailedStderr!.length).toBeLessThanOrEqual(4000);
            expect(gate.buildFailedStderr!.endsWith('…')).toBe(true);
        });

        it('falls back to stdout when stderr is empty', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ phase: 'development', repo_path: '/tmp/p' }))
                .mockResolvedValueOnce({ total: '1', done: '1' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

            const bvg = makeBuildVerificationGate({
                passed: false,
                failedStep: 'install',
                stderr: '',
                stdout: 'npm ERR! peer dep missing',
            });
            const manager = new PhaseGateManager(eventBus as never, bvg as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.buildFailedStderr).toContain('peer dep');
        });

        it('does NOT set buildFailedStep when build passes', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(buildProject({ phase: 'development', repo_path: '/tmp/p' }))
                .mockResolvedValueOnce({ total: '1', done: '1' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

            const bvg = makeBuildVerificationGate({ passed: true });
            const manager = new PhaseGateManager(eventBus as never, bvg as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.buildVerificationPassed).toBe(true);
            expect(gate.buildFailedStep).toBeUndefined();
            expect(gate.buildFailedStderr).toBeUndefined();
        });
    });

    // ── Pillar 2.2 PR-F — canAutoAdvance blocks on missing preview URL ──
    //
    // Regression test for the HabitForge smoke (2026-05-30) where the
    // bundle scaffold landed + .env.local materialised + next build
    // succeeded — but canAutoAdvance fired before scheduleDeployPreviewTask
    // could run, so Sensei jumped to launch-growth and Aegis wrote
    // production-deployment runbook docs instead of running vercel deploy.
    describe('checkGate() — Pillar 2.2 deploy-preview blocks auto-advance', () => {
        function makeBvg(passed: boolean): { verify: ReturnType<typeof vi.fn> } {
            return {
                verify: vi.fn(async () => ({
                    projectId: 'proj-001',
                    passed,
                    failedStep: null,
                    steps: [],
                })),
            };
        }

        it('sets canAutoAdvance=false when bundle wants build-tests-preview, build passed, but preview_url is NULL', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(
                    buildProject({
                        phase: 'development',
                        repo_path: '/tmp/p',
                        trust_level: 'high',
                        selected_bundle: 'stack::nextjs-saas',
                        preview_url: null,
                    } as never)
                )
                .mockResolvedValueOnce({ total: '5', done: '5' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never, makeBvg(true) as never);
            const gate = await manager.checkGate('proj-001');

            expect(gate.buildVerificationPassed).toBe(true);
            // The new guard: deploy-preview is pending → can't auto-advance.
            // Sensei reads this and falls through to scheduleDeployPreviewTask().
            expect(gate.canAutoAdvance).toBe(false);
        });

        it('sets canAutoAdvance=true once preview_url is populated', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(
                    buildProject({
                        phase: 'development',
                        repo_path: '/tmp/p',
                        trust_level: 'high',
                        selected_bundle: 'stack::nextjs-saas',
                        preview_url: 'https://habit-abc.vercel.app',
                    } as never)
                )
                .mockResolvedValueOnce({ total: '5', done: '5' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never, makeBvg(true) as never);
            const gate = await manager.checkGate('proj-001');

            // preview_url is set → deployPreviewPending = false → can auto-advance
            expect(gate.canAutoAdvance).toBe(true);
        });

        it('does NOT block auto-advance for bundles with html-ids acceptance (vanilla-html)', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(
                    buildProject({
                        phase: 'development',
                        repo_path: '/tmp/p',
                        trust_level: 'high',
                        selected_bundle: 'stack::vanilla-html',
                        preview_url: null,
                    } as never)
                )
                .mockResolvedValueOnce({ total: '5', done: '5' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never, makeBvg(true) as never);
            const gate = await manager.checkGate('proj-001');

            // vanilla-html uses html-ids acceptance — no preview URL needed.
            expect(gate.canAutoAdvance).toBe(true);
        });

        it('does NOT block auto-advance for phases other than development', async () => {
            mockDb.getOne
                .mockResolvedValueOnce(
                    buildProject({
                        phase: 'launch-growth',
                        repo_path: '/tmp/p',
                        trust_level: 'high',
                        selected_bundle: 'stack::nextjs-saas',
                        preview_url: null,
                    } as never)
                )
                .mockResolvedValueOnce({ total: '5', done: '5' });
            mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

            const manager = new PhaseGateManager(eventBus as never, makeBvg(true) as never);
            const gate = await manager.checkGate('proj-001');

            // deploy-preview only blocks AT the development → launch-growth gate.
            expect(gate.canAutoAdvance).toBe(true);
        });
    });
});
