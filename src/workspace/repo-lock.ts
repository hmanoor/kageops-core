/**
 * KageOps Repo Lock
 *
 * Per-repo async mutex so concurrent agents don't collide on .git/index.lock
 * or step on each other's working-tree state. Each repoPath gets its own
 * FIFO queue; operations run strictly in the order they acquire the lock.
 */

import * as path from 'path';

type Resolver = () => void;

const queues = new Map<string, Promise<void>>();

function normalize(repoPath: string): string {
    return path.resolve(repoPath).toLowerCase();
}

/**
 * Run `fn` while holding the mutex for `repoPath`. Returns fn's result.
 * The lock is released even if fn throws.
 */
export async function withRepoLock<T>(
    repoPath: string,
    fn: () => Promise<T>
): Promise<T> {
    const key = normalize(repoPath);
    const prev = queues.get(key) ?? Promise.resolve();

    let release: Resolver = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    queues.set(key, prev.then(() => gate));

    try {
        await prev;
        return await fn();
    } finally {
        release();
        // If our gate is still the tail of the queue, clear it so the map
        // doesn't grow unbounded across many short-lived repos.
        if (queues.get(key) === prev.then(() => gate)) {
            queues.delete(key);
        }
    }
}
