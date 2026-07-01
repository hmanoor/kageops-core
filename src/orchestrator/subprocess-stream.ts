/**
 * KageOps Subprocess Stream Helper (B-497)
 *
 * Pipes a child process's stdout/stderr to the event bus as
 * `subprocess.output` events so the Agent Terminal panel can tail
 * them in real time. Read-only — never writes to the child's stdin
 * and never alters the underlying spawn behaviour.
 *
 * The helper attaches `data` listeners to the child's stdout/stderr
 * pipes (when present) and converts each chunk to a string before
 * publishing. A spawned child with `stdio: 'ignore'` for stdout/stderr
 * simply produces no events — safe.
 */

import type { ChildProcess } from 'child_process';
import type { Readable } from 'stream';
import type { EventBus } from './event-bus';
import type { SubprocessSource, SubprocessStream } from '../shared/schemas';
import { createLogger } from '../shared/logger';

const log = createLogger('SubprocessStream');

// ── Types ────────────────────────────────────────────

export interface StreamSubprocessOptions {
    readonly projectId: string;
    readonly source: SubprocessSource;
    readonly taskId?: string;
    readonly agent?: string;
}

/** Minimal shape we need from a child process — easy to fake in tests. */
export interface SubprocessLike {
    readonly stdout?: Readable | null;
    readonly stderr?: Readable | null;
}

/** Minimal shape of EventBus.publish so we can swap mocks in tests. */
export interface SubprocessEventPublisher {
    publish(channel: 'subprocess.output', event: {
        readonly projectId?: string;
        readonly taskId?: string;
        readonly agent?: string;
        readonly data: Record<string, unknown>;
    }): Promise<void>;
}

// ── Public API ──────────────────────────────────────

/**
 * Attach data listeners to `child.stdout` / `child.stderr`. Each chunk
 * becomes a `subprocess.output` event on the bus with the same shape
 * regardless of source.
 *
 * `projectId` MUST be provided — the renderer filters by it. Sites that
 * don't have a projectId yet (e.g. Claude CLI calls before a project is
 * fully wired) should pass an explicit synthetic id like `"_global"` or
 * skip the helper entirely.
 *
 * Returns a disposer that detaches both listeners. Idempotent.
 */
export function streamSubprocessOutput(
    child: SubprocessLike | ChildProcess,
    bus: SubprocessEventPublisher,
    opts: StreamSubprocessOptions,
): () => void {
    if (opts.projectId === '' || opts.projectId === undefined) {
        // The schema requires projectId — bail rather than publishing
        // events that will be rejected downstream.
        log.warn({ source: opts.source }, 'streamSubprocessOutput called without projectId');
        return () => undefined;
    }

    const stdoutCleanup = pipeStream(child.stdout ?? null, bus, opts, 'stdout');
    const stderrCleanup = pipeStream(child.stderr ?? null, bus, opts, 'stderr');

    let disposed = false;
    return (): void => {
        if (disposed) return;
        disposed = true;
        stdoutCleanup();
        stderrCleanup();
    };
}

// ── Private ─────────────────────────────────────────

function pipeStream(
    stream: Readable | null | undefined,
    bus: SubprocessEventPublisher,
    opts: StreamSubprocessOptions,
    streamKind: SubprocessStream,
): () => void {
    if (stream === null || stream === undefined) {
        return () => undefined;
    }

    const onData = (data: unknown): void => {
        // Buffer.toString() handles Buffer, Uint8Array, and pre-decoded strings.
        // Defend against rare cases where the underlying pipe emits objects.
        const chunk = typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
                ? data.toString('utf-8')
                : String(data);

        if (chunk === '') return;

        const payload: Record<string, unknown> = {
            source: opts.source,
            stream: streamKind,
            chunk,
            ts: Date.now(),
        };

        const event: {
            projectId?: string;
            taskId?: string;
            agent?: string;
            data: Record<string, unknown>;
        } = {
            projectId: opts.projectId,
            data: payload,
        };
        if (opts.taskId !== undefined) event.taskId = opts.taskId;
        if (opts.agent !== undefined) event.agent = opts.agent;

        // Fire-and-forget. A bus failure must never disrupt the spawn site.
        void Promise.resolve()
            .then(() => bus.publish('subprocess.output', event))
            .catch((err) => {
                log.warn(
                    { err: err instanceof Error ? err.message : String(err), source: opts.source },
                    'subprocess.output publish failed'
                );
            });
    };

    stream.on('data', onData);

    return (): void => {
        try {
            stream.off('data', onData);
        } catch {
            // Stream may already be destroyed — safe to ignore.
        }
    };
}
