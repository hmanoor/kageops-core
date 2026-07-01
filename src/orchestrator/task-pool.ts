/**
 * KageOps Task Pool — Concurrency Semaphore
 *
 * Controls parallel task dispatch with a counting semaphore.
 * Prevents runaway parallelism and enables graceful shutdown via drain().
 */

import { createLogger } from '../shared/logger';

const log = createLogger('TaskPool');

// ── TaskPool ─────────────────────────────────────────

export class TaskPool {
    private readonly _maxConcurrency: number;
    private _activeTasks = 0;

    /**
     * Resolve callbacks waiting for a free slot.
     * Each entry is a resolver from a pending acquire() Promise.
     */
    private readonly waitQueue: Array<() => void> = [];

    /**
     * Resolve callbacks waiting for all slots to drain.
     * Used by drain() during graceful shutdown.
     */
    private readonly drainWaiters: Array<() => void> = [];

    /**
     * @param maxConcurrency Max parallel tasks. Defaults to KAGEOPS_MAX_CONCURRENCY env var, or 3.
     */
    constructor(maxConcurrency?: number) {
        const envValue = process.env['KAGEOPS_MAX_CONCURRENCY'];
        const envParsed = envValue !== undefined ? parseInt(envValue, 10) : NaN;
        const fromEnv = !isNaN(envParsed) && envParsed > 0 ? envParsed : null;

        this._maxConcurrency = maxConcurrency ?? fromEnv ?? 3;

        if (this._maxConcurrency < 1) {
            throw new Error(`maxConcurrency must be >= 1, got ${this._maxConcurrency}`);
        }

        log.info({ maxConcurrency: this._maxConcurrency }, 'TaskPool created');
    }

    // ── Public API ───────────────────────────────────

    /**
     * Acquire a slot. If the pool is at capacity, waits until a slot is freed.
     */
    async acquire(): Promise<void> {
        if (this._activeTasks < this._maxConcurrency) {
            this._activeTasks += 1;
            log.debug({ active: this._activeTasks, max: this._maxConcurrency }, 'Slot acquired');
            return;
        }

        // At capacity — queue up until release() frees a slot
        await new Promise<void>((resolve) => {
            this.waitQueue.push(resolve);
        });

        this._activeTasks += 1;
        log.debug({ active: this._activeTasks, max: this._maxConcurrency }, 'Slot acquired (after wait)');
    }

    /**
     * Release a slot. If callers are waiting, the next one is unblocked.
     * Safe to call even when activeTasks is already 0 (no-op in that case).
     */
    release(): void {
        if (this._activeTasks === 0) {
            log.warn('release() called with no active tasks — ignoring');
            return;
        }

        this._activeTasks -= 1;
        log.debug({ active: this._activeTasks, max: this._maxConcurrency }, 'Slot released');

        // Unblock the next waiter if any.
        // Note: the waiter will call `_activeTasks += 1` when it resumes, so
        // the count is transiently low here — don't notify drain waiters yet.
        const next = this.waitQueue.shift();
        if (next !== undefined) {
            next();
            // The waiter immediately takes this slot — count will go back up.
            // Do NOT notify drain waiters here.
            return;
        }

        // No waiting acquires — if pool is fully drained, unblock drain() waiters
        if (this._activeTasks === 0) {
            const waiting = this.drainWaiters.splice(0);
            for (const resolve of waiting) {
                resolve();
            }
        }
    }

    /**
     * Wait until all active tasks complete (activeTasks reaches 0).
     * Resolves immediately if the pool is already empty.
     * Used for graceful shutdown.
     */
    async drain(): Promise<void> {
        if (this._activeTasks === 0) {
            return;
        }

        log.info({ active: this._activeTasks }, 'Draining TaskPool...');

        await new Promise<void>((resolve) => {
            this.drainWaiters.push(resolve);
        });

        log.info('TaskPool drained.');
    }

    // ── Accessors ────────────────────────────────────

    /**
     * Number of currently active (acquired but not yet released) slots.
     */
    get activeTasks(): number {
        return this._activeTasks;
    }

    /**
     * Whether there is at least one free slot available.
     */
    get available(): boolean {
        return this._activeTasks < this._maxConcurrency;
    }

    /**
     * The configured maximum concurrency.
     */
    get maxConcurrency(): number {
        return this._maxConcurrency;
    }
}
