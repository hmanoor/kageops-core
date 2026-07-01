/**
 * subprocess-stream tests (B-497)
 *
 * Verifies the helper:
 *   - Publishes a `subprocess.output` event for every stdout/stderr chunk.
 *   - Tags events with the supplied projectId/source/agent metadata.
 *   - Survives a child with no stdio pipes (returns a no-op disposer).
 *   - Stops listening when the disposer is called.
 *   - Validates published events against the schema.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import {
    streamSubprocessOutput,
    type SubprocessEventPublisher,
} from '../../src/orchestrator/subprocess-stream';
import { SubprocessOutputEventSchema } from '../../src/shared/schemas';

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
    }),
}));

// ── Helpers ─────────────────────────────────────────

interface FakeChild {
    stdout: Readable;
    stderr: Readable;
}

function createFakeChild(): FakeChild {
    // Readable in object/string mode emits whatever we push.
    const stdout = new Readable({ read() { /* push driven manually */ } });
    const stderr = new Readable({ read() { /* push driven manually */ } });
    // Don't auto-end; tests close the streams explicitly.
    return { stdout, stderr };
}

interface PublishedRecord {
    readonly channel: string;
    readonly event: {
        readonly projectId?: string;
        readonly taskId?: string;
        readonly agent?: string;
        readonly data: Record<string, unknown>;
    };
}

function createRecordingPublisher(): {
    publisher: SubprocessEventPublisher;
    published: readonly PublishedRecord[];
} {
    const records: PublishedRecord[] = [];
    const publisher: SubprocessEventPublisher = {
        publish: async (channel, event) => {
            records.push({ channel, event });
        },
    };
    return {
        publisher,
        get published(): readonly PublishedRecord[] { return records; },
    };
}

function flushAsync(): Promise<void> {
    // streamSubprocessOutput defers publish to a microtask + one queueMicrotask
    // hop so the spawn site's listener returns synchronously. Awaiting two ticks
    // is sufficient.
    return new Promise((resolve) => setImmediate(resolve));
}

// ── Tests ───────────────────────────────────────────

describe('streamSubprocessOutput', () => {
    it('publishes a subprocess.output event for each stdout chunk', async () => {
        const child = createFakeChild();
        const { publisher, published } = createRecordingPublisher();

        streamSubprocessOutput(child, publisher, {
            projectId: 'proj-1',
            source: 'build-verification',
            agent: 'system',
        });

        child.stdout.emit('data', Buffer.from('hello\n'));
        child.stdout.emit('data', 'world\n');

        await flushAsync();

        expect(published).toHaveLength(2);
        expect(published[0]?.channel).toBe('subprocess.output');
        expect(published[0]?.event.projectId).toBe('proj-1');
        expect(published[0]?.event.data['source']).toBe('build-verification');
        expect(published[0]?.event.data['stream']).toBe('stdout');
        expect(published[0]?.event.data['chunk']).toBe('hello\n');
        expect(published[1]?.event.data['chunk']).toBe('world\n');
    });

    it('publishes stderr chunks tagged with stream=stderr', async () => {
        const child = createFakeChild();
        const { publisher, published } = createRecordingPublisher();

        streamSubprocessOutput(child, publisher, {
            projectId: 'proj-2',
            source: 'github-push',
        });

        child.stderr.emit('data', Buffer.from('warn: detached HEAD'));
        await flushAsync();

        expect(published).toHaveLength(1);
        expect(published[0]?.event.data['stream']).toBe('stderr');
        expect(published[0]?.event.data['source']).toBe('github-push');
    });

    it('preserves the supplied taskId and agent on every event', async () => {
        const child = createFakeChild();
        const { publisher, published } = createRecordingPublisher();

        streamSubprocessOutput(child, publisher, {
            projectId: 'p',
            source: 'claude-cli',
            taskId: 'task-7',
            agent: 'forge',
        });

        child.stdout.emit('data', 'x');
        await flushAsync();

        expect(published[0]?.event.taskId).toBe('task-7');
        expect(published[0]?.event.agent).toBe('forge');
    });

    it('produces events that pass the SubprocessOutputEventSchema', async () => {
        const child = createFakeChild();
        const { publisher, published } = createRecordingPublisher();

        streamSubprocessOutput(child, publisher, {
            projectId: 'p',
            source: 'template-cloner',
        });

        child.stdout.emit('data', 'snapshot ready\n');
        await flushAsync();

        expect(published).toHaveLength(1);
        const evt = published[0]!.event;
        const validated = SubprocessOutputEventSchema.parse({
            projectId: evt.projectId,
            ...(evt.taskId !== undefined ? { taskId: evt.taskId } : {}),
            ...(evt.agent !== undefined ? { agent: evt.agent } : {}),
            source: evt.data['source'],
            stream: evt.data['stream'],
            chunk: evt.data['chunk'],
            ts: evt.data['ts'],
        });
        expect(validated.source).toBe('template-cloner');
        expect(validated.stream).toBe('stdout');
        expect(validated.chunk).toBe('snapshot ready\n');
        expect(typeof validated.ts).toBe('number');
    });

    it('drops empty chunks without publishing', async () => {
        const child = createFakeChild();
        const { publisher, published } = createRecordingPublisher();

        streamSubprocessOutput(child, publisher, {
            projectId: 'p',
            source: 'build-verification',
        });

        child.stdout.emit('data', '');
        child.stdout.emit('data', Buffer.from(''));
        await flushAsync();

        expect(published).toHaveLength(0);
    });

    it('returns a no-op disposer when projectId is empty', async () => {
        const child = createFakeChild();
        const { publisher, published } = createRecordingPublisher();

        const dispose = streamSubprocessOutput(child, publisher, {
            projectId: '',
            source: 'build-verification',
        });

        child.stdout.emit('data', 'should-not-publish\n');
        await flushAsync();

        expect(published).toHaveLength(0);
        // Disposer must be safe to call even though we never attached.
        expect(() => dispose()).not.toThrow();
    });

    it('detaches listeners when the disposer runs', async () => {
        const child = createFakeChild();
        const { publisher, published } = createRecordingPublisher();

        const dispose = streamSubprocessOutput(child, publisher, {
            projectId: 'p',
            source: 'build-verification',
        });

        child.stdout.emit('data', 'before\n');
        await flushAsync();
        expect(published).toHaveLength(1);

        dispose();

        child.stdout.emit('data', 'after\n');
        await flushAsync();

        // Listener detached → no second publish.
        expect(published).toHaveLength(1);
    });

    it('survives a publisher that rejects without crashing', async () => {
        const child = createFakeChild();
        const publisher: SubprocessEventPublisher = {
            publish: vi.fn(async () => {
                throw new Error('bus offline');
            }),
        };

        streamSubprocessOutput(child, publisher, {
            projectId: 'p',
            source: 'build-verification',
        });

        child.stdout.emit('data', 'still flowing\n');
        await flushAsync();

        expect(publisher.publish).toHaveBeenCalledTimes(1);
        // No assertion on rethrow — getting here without an unhandled rejection
        // proves the helper swallowed the bus failure.
    });

    it('handles a child with no stdio pipes (stdio: ignore)', () => {
        const noPipesChild = new EventEmitter() as unknown as { stdout: null; stderr: null };
        const { publisher, published } = createRecordingPublisher();

        const dispose = streamSubprocessOutput(noPipesChild, publisher, {
            projectId: 'p',
            source: 'build-verification',
        });

        // Disposer must be callable; nothing was attached.
        expect(() => dispose()).not.toThrow();
        expect(published).toHaveLength(0);
    });
});
