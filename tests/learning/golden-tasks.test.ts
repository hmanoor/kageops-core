/**
 * Tests for src/learning/golden-tasks.ts (B-471 follow-up)
 *
 * Covers:
 *   1. loadGoldenTasks returns tasks for each APO-eligible agent
 *   2. Throws for non-eligible agents (sensei/blueprint/forge/etc)
 *   3. Throws for eligible agents with no tasks defined
 *   4. Returned array and tasks are frozen
 *   5. listAgentsWithGoldenTasks lists every APO-eligible agent with tasks
 *   6. Task shape: id + description both populated, short enough to keep
 *      per-task cost low
 */

import { describe, expect, it } from 'vitest';
import {
    listAgentsWithGoldenTasks,
    loadGoldenTasks,
} from '../../src/learning/golden-tasks';
import { APO_ELIGIBLE_AGENTS } from '../../src/learning/types';

describe('golden-tasks', () => {
    describe('loadGoldenTasks', () => {
        it.each([...APO_ELIGIBLE_AGENTS])(
            'returns tasks for APO-eligible agent "%s"',
            (agent) => {
                const tasks = loadGoldenTasks(agent);
                expect(tasks.length).toBeGreaterThan(0);
                for (const task of tasks) {
                    expect(typeof task.id).toBe('string');
                    expect(task.id.length).toBeGreaterThan(0);
                    expect(typeof task.description).toBe('string');
                    expect(task.description.length).toBeGreaterThan(0);
                }
            }
        );

        it('ships exactly 6 tasks per eligible agent (keeps per-candidate cost bounded)', () => {
            for (const agent of APO_ELIGIBLE_AGENTS) {
                const tasks = loadGoldenTasks(agent);
                expect(tasks.length).toBe(6);
            }
        });

        it('gives every task a unique id within its agent bucket', () => {
            for (const agent of APO_ELIGIBLE_AGENTS) {
                const ids = loadGoldenTasks(agent).map((t) => t.id);
                expect(new Set(ids).size).toBe(ids.length);
            }
        });

        it('namespaces ids with the agent prefix (scout.*, herald.*, pixel.*)', () => {
            for (const agent of APO_ELIGIBLE_AGENTS) {
                const tasks = loadGoldenTasks(agent);
                for (const task of tasks) {
                    expect(task.id.startsWith(`${agent}.`)).toBe(true);
                }
            }
        });

        it('keeps descriptions short to keep per-task eval cost low (<300 chars)', () => {
            for (const agent of APO_ELIGIBLE_AGENTS) {
                for (const task of loadGoldenTasks(agent)) {
                    expect(task.description.length).toBeLessThan(300);
                }
            }
        });

        it('throws for agents not in APO scope', () => {
            expect(() => loadGoldenTasks('sensei')).toThrow(
                /not APO-eligible/
            );
            expect(() => loadGoldenTasks('forge')).toThrow(
                /not APO-eligible/
            );
            expect(() => loadGoldenTasks('blueprint')).toThrow(
                /not APO-eligible/
            );
        });

        it('throws for unknown agent names', () => {
            expect(() => loadGoldenTasks('nonsense-agent')).toThrow(
                /not APO-eligible/
            );
        });

        it('deep-freezes the returned array and each task', () => {
            const tasks = loadGoldenTasks('scout');
            expect(Object.isFrozen(tasks)).toBe(true);
            for (const task of tasks) {
                expect(Object.isFrozen(task)).toBe(true);
            }
        });
    });

    describe('listAgentsWithGoldenTasks', () => {
        it('lists every APO-eligible agent that has tasks defined', () => {
            const agents = listAgentsWithGoldenTasks();
            // golden-tasks.json currently seeds all three APO-eligible agents.
            for (const agent of APO_ELIGIBLE_AGENTS) {
                expect(agents).toContain(agent);
            }
        });

        it('returns a frozen array', () => {
            const agents = listAgentsWithGoldenTasks();
            expect(Object.isFrozen(agents)).toBe(true);
        });

        it('never lists agents outside APO scope', () => {
            const agents = listAgentsWithGoldenTasks();
            for (const agent of agents) {
                expect(APO_ELIGIBLE_AGENTS).toContain(agent);
            }
        });
    });
});
