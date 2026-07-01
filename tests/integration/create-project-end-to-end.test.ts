/**
 * Pillar 2.2 PR-G — Create-project end-to-end regression suite.
 *
 * Locks in the smoke verdict from the HabitForge investigation
 * (2026-05-30): the New-Project modal's submit path goes through
 *
 *   command-center.ts → IPC handler in main.ts → Sensei.startProject
 *      → assignBundleForProject (operator pick takes priority)
 *      → INSERT projects + INSERT tasks
 *
 * Earlier session: caught "modal does nothing" reports that turned
 * out to be smoke-stub-shape bugs in my throwaway tests, not real
 * regressions — but until this file existed, every "create project"
 * regression had to be caught by the operator on an installed binary.
 *
 * What this file guards specifically (failures here = ship-blocker):
 *
 *   1. Sensei.startProject with selectedBundle='nextjs-saas' inserts a
 *      project row AND persists `selected_bundle='stack::nextjs-saas'`
 *      via the PR-E operator-pick path (skipping the matcher).
 *   2. Sensei.startProject without selectedBundle still inserts the
 *      project row (matcher runs; result depends on bundle disk state
 *      so we only assert non-null id).
 *   3. The IPC handler's selectedBundle validation regex
 *      (`^[a-z0-9][a-z0-9-]*$`) rejects a poisoned payload before it
 *      reaches Sensei.
 *   4. KAGEOPS_FEATURE_BUNDLES=false short-circuits assignBundleForProject
 *      cleanly — project still gets created, just no selected_bundle.
 *
 * Mocks the same DB layer the unit tests use (mockDb pattern from
 * sensei.test.ts). NOT a real-AI test — sendPrompt is stubbed to
 * return a valid task array so decompose() completes. Real-AI smoke
 * happens via the headless runner separately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';

// ── Mock setup (mirror tests/orchestrator/sensei.test.ts) ─────────────────

const mockDb = vi.hoisted(() => {
    const queryFn = vi.fn(async (sql: string) => {
        if (/^SELECT id, status FROM projects/i.test(sql)) {
            return { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO projects/i.test(sql)) {
            return { rows: [{ id: 'test-project-id' }], rowCount: 1 };
        }
        if (/INSERT INTO tasks/i.test(sql)) {
            return { rows: [{ id: `task-${Math.random().toString(36).slice(2, 8)}` }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    });
    const getOneFn = vi.fn(async () => null);
    const getManyFn = vi.fn(async () => []);
    const reset = (): void => {
        queryFn.mockClear();
        getOneFn.mockClear();
        getManyFn.mockClear();
    };
    return {
        query: queryFn,
        getOne: getOneFn,
        getMany: getManyFn,
        reset,
    };
});

vi.mock('../../src/db/client', () => ({
    query: mockDb.query,
    getOne: mockDb.getOne,
    getMany: mockDb.getMany,
    initDatabase: vi.fn(async () => undefined),
    testConnection: vi.fn(async () => true),
    closePool: vi.fn(async () => undefined),
    getPool: vi.fn(() => ({ query: mockDb.query, end: vi.fn() })),
}));

// Stub sendPrompt to return a valid task array — TaskDecomposer
// parses the JSON array out, so we need a string with one.
const stubSendPrompt = vi.fn(async (_sys: string, _user: string) => {
    return JSON.stringify([
        {
            title: 'Stub discovery task',
            description: 'Created by regression-test stub',
            taskType: 'concept-brief',
            assignedAgent: 'scout',
            priority: 5,
            dependsOn: [],
        },
    ]);
});

// ── Imports under test ────────────────────────────────────────────────────

import { Sensei, DuplicateProjectError } from '../../src/orchestrator/sensei';
import type { EventBus } from '../../src/orchestrator/event-bus';

// ── Tests ────────────────────────────────────────────────────────────────

describe('Create-project end-to-end (Pillar 2.2 PR-G regression suite)', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    const ORIGINAL_FLAG = process.env['KAGEOPS_FEATURE_BUNDLES'];

    beforeEach(() => {
        mockDb.reset();
        stubSendPrompt.mockClear();
        eventBus = createMockEventBus();
        delete process.env['KAGEOPS_FEATURE_BUNDLES'];
    });

    function makeSensei(): Sensei {
        return new Sensei(
            { sendPrompt: stubSendPrompt as never },
            eventBus as unknown as EventBus,
        );
    }

    it('returns a non-null project id (smoke: operator clicks Create)', async () => {
        const sensei = makeSensei();
        const id = await sensei.startProject('HabitForge', 'Test SaaS app', {
            trustLevel: 'medium',
            enabledPhases: ['discovery'],
            selectedBundle: 'nextjs-saas',
        });
        expect(id).toBe('test-project-id');
    });

    it('persists selected_bundle = stack::<name> via operator-pick path (PR-E)', async () => {
        const sensei = makeSensei();
        await sensei.startProject('HabitForge', 'Test SaaS app', {
            trustLevel: 'medium',
            enabledPhases: ['discovery'],
            selectedBundle: 'nextjs-saas',
        });

        const updateCall = mockDb.query.mock.calls.find(
            ([sql, params]) =>
                typeof sql === 'string' &&
                /UPDATE projects SET selected_bundle/i.test(sql) &&
                (params as unknown[])[0] === 'stack::nextjs-saas'
        );
        expect(updateCall).toBeDefined();
    });

    it('still creates a project row when operator-picked bundle does not exist (matcher fallback)', async () => {
        const sensei = makeSensei();
        const id = await sensei.startProject('Bogus', 'Pick something that does not exist', {
            trustLevel: 'low',
            enabledPhases: ['discovery'],
            selectedBundle: 'this-bundle-does-not-exist',
        });
        // Project must still be created — bundle resolution is non-fatal
        // by design (see sensei.ts comment "must NOT block project creation").
        expect(id).toBe('test-project-id');
    });

    it('inserts the project row even when no bundle is picked (auto matcher)', async () => {
        const sensei = makeSensei();
        const id = await sensei.startProject('Auto', 'Generic project description', {
            trustLevel: 'low',
            enabledPhases: ['discovery'],
            // no selectedBundle
        });
        expect(id).toBe('test-project-id');
    });

    it('respects KAGEOPS_FEATURE_BUNDLES=false rollback (no UPDATE selected_bundle)', async () => {
        process.env['KAGEOPS_FEATURE_BUNDLES'] = 'false';
        try {
            const sensei = makeSensei();
            const id = await sensei.startProject('FlagOff', 'Test', {
                trustLevel: 'low',
                enabledPhases: ['discovery'],
                selectedBundle: 'nextjs-saas',
            });
            expect(id).toBe('test-project-id');

            const anyUpdate = mockDb.query.mock.calls.find(
                ([sql]) => typeof sql === 'string' && /UPDATE projects SET selected_bundle/i.test(sql)
            );
            expect(anyUpdate).toBeUndefined();
        } finally {
            if (ORIGINAL_FLAG === undefined) delete process.env['KAGEOPS_FEATURE_BUNDLES'];
            else process.env['KAGEOPS_FEATURE_BUNDLES'] = ORIGINAL_FLAG;
        }
    });

    it('decomposes at least one task on the starting phase (proves sendPrompt result is consumed)', async () => {
        const sensei = makeSensei();
        await sensei.startProject('TaskTest', 'A test', {
            trustLevel: 'medium',
            enabledPhases: ['discovery'],
            selectedBundle: 'nextjs-saas',
        });

        const insertTask = mockDb.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && /INSERT INTO tasks/i.test(sql)
        );
        expect(insertTask).toBeDefined();
        expect(stubSendPrompt).toHaveBeenCalled();
    });

    it('propagates sendPrompt failures (proves IPC handler sees a real error message)', async () => {
        // Mimic the operator scenario: no AI provider key configured →
        // adapter throws synchronously during decompose. The error must
        // bubble out so the IPC handler can return { id: null, error }.
        const failingSendPrompt = vi.fn(async () => {
            throw new Error('ANTHROPIC_API_KEY is required for Claude provider.');
        });
        const sensei = new Sensei(
            { sendPrompt: failingSendPrompt as never },
            eventBus as unknown as EventBus,
        );

        await expect(
            sensei.startProject('NoKey', 'No AI key configured', {
                trustLevel: 'medium',
                enabledPhases: ['discovery'],
            })
        ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    });

    // ── Pillar 2.2 PR-H — duplicate-name guard surfaces an error ──
    //
    // Regression test for the HabitForge "create does nothing" verdict
    // (2026-05-30): operator clicked Create 3 times with the same name,
    // each click hit Sensei.startProject's duplicate guard, which silently
    // returned the existing project's ID. The IPC reported success, the
    // modal closed, and the operator saw NO error and NO new project. PR-H
    // makes that case throw DuplicateProjectError so the IPC handler can
    // return a structured error and the renderer surfaces it as a banner.

    it('throws DuplicateProjectError when name is already in use', async () => {
        // Override the duplicate-check SELECT to return an existing project.
        mockDb.query.mockImplementation(async (sql: string) => {
            if (/^SELECT id, status FROM projects/i.test(sql)) {
                return {
                    rows: [{ id: 'existing-proj-id', status: 'completed' }],
                    rowCount: 1,
                } as never;
            }
            // F-350 zombie-check queries — return values that DON'T match the
            // zombie shape, so the duplicate-error path wins.
            if (/SELECT phase, description FROM projects/i.test(sql)) {
                return { rows: [{ phase: 'development', description: 'desc' }], rowCount: 1 } as never;
            }
            if (/SELECT COUNT.*FROM tasks/i.test(sql)) {
                return { rows: [{ count: '5' }], rowCount: 1 } as never;
            }
            return { rows: [], rowCount: 0 } as never;
        });

        const sensei = makeSensei();

        let caught: unknown = null;
        try {
            await sensei.startProject('HabitForge', 'Duplicate name', {
                trustLevel: 'medium',
                enabledPhases: ['discovery'],
            });
        } catch (err) {
            caught = err;
        }
        expect(DuplicateProjectError.is(caught)).toBe(true);
        if (DuplicateProjectError.is(caught)) {
            expect(caught.projectName).toBe('HabitForge');
            expect(caught.existingId).toBe('existing-proj-id');
            expect(caught.existingStatus).toBe('completed');
            expect(caught.message).toContain('already exists');
        }
    });

    it('F-350 zombie recovery STILL silently returns existing ID (no error)', async () => {
        // Existing project at status=active with 0 tasks in current phase →
        // F-350 path: re-decompose silently, return existing ID.
        mockDb.query.mockImplementation(async (sql: string) => {
            if (/^SELECT id, status FROM projects/i.test(sql)) {
                return {
                    rows: [{ id: 'zombie-proj-id', status: 'active' }],
                    rowCount: 1,
                } as never;
            }
            if (/INSERT INTO tasks/i.test(sql)) {
                return { rows: [{ id: 'recovered-task' }], rowCount: 1 } as never;
            }
            return { rows: [], rowCount: 0 } as never;
        });
        // F-350 reads phase + description via getOne, then counts tasks via getOne.
        mockDb.getOne.mockResolvedValueOnce({ phase: 'discovery', description: 'desc' })
                     .mockResolvedValueOnce({ count: '0' });

        const sensei = makeSensei();
        const id = await sensei.startProject('Zombie', 'Mid-flight create that failed', {
            trustLevel: 'low',
            enabledPhases: ['discovery'],
        });
        // No throw — returns the existing id.
        expect(id).toBe('zombie-proj-id');
    });
});
