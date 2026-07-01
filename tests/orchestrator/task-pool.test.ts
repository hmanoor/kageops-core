/**
 * TaskPool unit tests
 *
 * Tests the counting semaphore used for agent concurrency control:
 * acquire/release, blocking at capacity, drain, properties, and
 * edge cases (release underflow, concurrent acquires, env var config).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskPool } from '../../src/orchestrator/task-pool';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * Useful for testing time-based blocking behaviour with fake timers.
 */
function tick(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TaskPool', () => {

    // ── Constructor ──────────────────────────────────

    describe('constructor', () => {
        it('defaults to maxConcurrency=3 when no argument and no env var', () => {
            delete process.env['KAGEOPS_MAX_CONCURRENCY'];
            const pool = new TaskPool();
            expect(pool.maxConcurrency).toBe(3);
        });

        it('uses the provided maxConcurrency argument', () => {
            const pool = new TaskPool(5);
            expect(pool.maxConcurrency).toBe(5);
        });

        it('reads KAGEOPS_MAX_CONCURRENCY env var when no argument supplied', () => {
            process.env['KAGEOPS_MAX_CONCURRENCY'] = '7';
            const pool = new TaskPool();
            expect(pool.maxConcurrency).toBe(7);
            delete process.env['KAGEOPS_MAX_CONCURRENCY'];
        });

        it('explicit argument takes precedence over env var', () => {
            process.env['KAGEOPS_MAX_CONCURRENCY'] = '7';
            const pool = new TaskPool(2);
            expect(pool.maxConcurrency).toBe(2);
            delete process.env['KAGEOPS_MAX_CONCURRENCY'];
        });

        it('ignores invalid env var values and falls back to 3', () => {
            process.env['KAGEOPS_MAX_CONCURRENCY'] = 'not-a-number';
            const pool = new TaskPool();
            expect(pool.maxConcurrency).toBe(3);
            delete process.env['KAGEOPS_MAX_CONCURRENCY'];
        });

        it('throws when maxConcurrency < 1', () => {
            expect(() => new TaskPool(0)).toThrow(/maxConcurrency must be >= 1/);
        });

        it('throws when maxConcurrency is negative', () => {
            expect(() => new TaskPool(-1)).toThrow(/maxConcurrency must be >= 1/);
        });
    });

    // ── Initial state ────────────────────────────────

    describe('initial state', () => {
        let pool: TaskPool;

        beforeEach(() => {
            pool = new TaskPool(3);
        });

        it('starts with activeTasks=0', () => {
            expect(pool.activeTasks).toBe(0);
        });

        it('starts as available', () => {
            expect(pool.available).toBe(true);
        });
    });

    // ── acquire / release cycle ──────────────────────

    describe('acquire() / release()', () => {
        let pool: TaskPool;

        beforeEach(() => {
            pool = new TaskPool(3);
        });

        it('increments activeTasks on acquire', async () => {
            await pool.acquire();
            expect(pool.activeTasks).toBe(1);
        });

        it('decrements activeTasks on release', async () => {
            await pool.acquire();
            pool.release();
            expect(pool.activeTasks).toBe(0);
        });

        it('allows acquiring up to maxConcurrency slots', async () => {
            await pool.acquire();
            await pool.acquire();
            await pool.acquire();
            expect(pool.activeTasks).toBe(3);
        });

        it('becomes unavailable when at capacity', async () => {
            await pool.acquire();
            await pool.acquire();
            await pool.acquire();
            expect(pool.available).toBe(false);
        });

        it('becomes available again after a release', async () => {
            await pool.acquire();
            await pool.acquire();
            await pool.acquire();
            pool.release();
            expect(pool.available).toBe(true);
            expect(pool.activeTasks).toBe(2);
        });

        it('handles multiple acquire/release cycles correctly', async () => {
            for (let i = 0; i < 10; i++) {
                await pool.acquire();
                pool.release();
            }
            expect(pool.activeTasks).toBe(0);
            expect(pool.available).toBe(true);
        });
    });

    // ── blocking at capacity ─────────────────────────

    describe('blocking at capacity', () => {
        it('acquire blocks when pool is at capacity and resolves after release', async () => {
            const pool = new TaskPool(1);

            await pool.acquire(); // fills the single slot

            let unblocked = false;

            // This acquire should block until release() is called
            const waitingAcquire = pool.acquire().then(() => {
                unblocked = true;
            });

            // Still blocked — release not called yet
            await tick(); // let microtasks run
            expect(unblocked).toBe(false);

            // Release the slot
            pool.release();

            // Now the blocked acquire should unblock
            await waitingAcquire;
            expect(unblocked).toBe(true);
            expect(pool.activeTasks).toBe(1); // new acquire consumed the freed slot
        });

        it('queued acquires are processed in order', async () => {
            const pool = new TaskPool(1);
            await pool.acquire(); // fill the pool

            const order: number[] = [];
            const p1 = pool.acquire().then(() => { order.push(1); });
            const p2 = pool.acquire().then(() => { order.push(2); });
            const p3 = pool.acquire().then(() => { order.push(3); });

            await tick();
            pool.release(); // unblocks waiter 1

            await tick();
            pool.release(); // unblocks waiter 2

            await tick();
            pool.release(); // unblocks waiter 3

            await Promise.all([p1, p2, p3]);
            expect(order).toEqual([1, 2, 3]);
        });

        it('allows up to maxConcurrency concurrent acquires without blocking', async () => {
            const pool = new TaskPool(5);

            // All 5 should resolve immediately
            const promises = Array.from({ length: 5 }, () => pool.acquire());
            await Promise.all(promises);

            expect(pool.activeTasks).toBe(5);
            expect(pool.available).toBe(false);
        });
    });

    // ── release edge cases ───────────────────────────

    describe('release() edge cases', () => {
        it('does not go negative when release called with no active tasks', () => {
            const pool = new TaskPool(3);
            pool.release(); // should be a no-op, not throw
            expect(pool.activeTasks).toBe(0);
        });

        it('release is idempotent when called extra times', async () => {
            const pool = new TaskPool(3);
            await pool.acquire();
            pool.release();
            pool.release(); // extra call — should be ignored
            expect(pool.activeTasks).toBe(0);
        });
    });

    // ── drain() ──────────────────────────────────────

    describe('drain()', () => {
        it('resolves immediately when pool is already empty', async () => {
            const pool = new TaskPool(3);
            await expect(pool.drain()).resolves.toBeUndefined();
        });

        it('waits until all active tasks are released', async () => {
            const pool = new TaskPool(3);

            await pool.acquire();
            await pool.acquire();

            let drained = false;
            const drainPromise = pool.drain().then(() => {
                drained = true;
            });

            await tick();
            expect(drained).toBe(false); // still active tasks

            pool.release();
            await tick();
            expect(drained).toBe(false); // one still active

            pool.release();
            await drainPromise;
            expect(drained).toBe(true);
        });

        it('multiple drain() calls all resolve when pool empties', async () => {
            const pool = new TaskPool(2);
            await pool.acquire();

            const results: boolean[] = [];
            const d1 = pool.drain().then(() => { results.push(true); });
            const d2 = pool.drain().then(() => { results.push(true); });

            pool.release();
            await Promise.all([d1, d2]);

            expect(results).toHaveLength(2);
            expect(pool.activeTasks).toBe(0);
        });

        it('drain resolves even after acquire unblocks waiting tasks', async () => {
            const pool = new TaskPool(1);
            await pool.acquire(); // fill pool

            // Queue another acquire
            let acquired = false;
            const waiter = pool.acquire().then(() => {
                acquired = true;
            });

            // Start draining
            let drained = false;
            const drainPromise = pool.drain().then(() => {
                drained = true;
            });

            // Release the first slot (unblocks waiter, which acquires it)
            pool.release();
            await waiter;
            expect(acquired).toBe(true);
            expect(drained).toBe(false); // waiter has the slot now

            // Release the slot taken by waiter
            pool.release();
            await drainPromise;
            expect(drained).toBe(true);
        });
    });

    // ── activeTasks property ─────────────────────────

    describe('activeTasks property', () => {
        it('reflects current count accurately through multiple operations', async () => {
            const pool = new TaskPool(5);

            expect(pool.activeTasks).toBe(0);
            await pool.acquire();
            expect(pool.activeTasks).toBe(1);
            await pool.acquire();
            expect(pool.activeTasks).toBe(2);
            pool.release();
            expect(pool.activeTasks).toBe(1);
            pool.release();
            expect(pool.activeTasks).toBe(0);
        });
    });

    // ── available property ───────────────────────────

    describe('available property', () => {
        it('is true when activeTasks < maxConcurrency', async () => {
            const pool = new TaskPool(2);
            await pool.acquire();
            expect(pool.available).toBe(true);
        });

        it('is false when activeTasks === maxConcurrency', async () => {
            const pool = new TaskPool(2);
            await pool.acquire();
            await pool.acquire();
            expect(pool.available).toBe(false);
        });

        it('is true with maxConcurrency=1 when nothing acquired', () => {
            const pool = new TaskPool(1);
            expect(pool.available).toBe(true);
        });

        it('is false with maxConcurrency=1 when one slot acquired', async () => {
            const pool = new TaskPool(1);
            await pool.acquire();
            expect(pool.available).toBe(false);
        });
    });

    // ── concurrent acquire stress test ───────────────

    describe('concurrent acquires up to max', () => {
        it('correctly handles N concurrent acquires where N = maxConcurrency', async () => {
            const pool = new TaskPool(4);

            const acquisitions = await Promise.all([
                pool.acquire(),
                pool.acquire(),
                pool.acquire(),
                pool.acquire(),
            ]);

            expect(acquisitions).toHaveLength(4);
            expect(pool.activeTasks).toBe(4);
            expect(pool.available).toBe(false);
        });

        it('excess acquires block until slots free', async () => {
            const pool = new TaskPool(2);

            await pool.acquire();
            await pool.acquire();

            let thirdResolved = false;
            const third = pool.acquire().then(() => {
                thirdResolved = true;
            });

            await tick();
            expect(thirdResolved).toBe(false);

            pool.release();
            await third;
            expect(thirdResolved).toBe(true);
            expect(pool.activeTasks).toBe(2); // 1 remaining + 1 new
        });
    });
});
