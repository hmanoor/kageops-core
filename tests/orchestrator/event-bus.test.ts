/**
 * EventBus behavioral tests
 *
 * Tests every observable behavior of EventBus in isolation.
 * Both external dependencies are fully mocked:
 *   - `pg` Client  — the dedicated LISTEN/NOTIFY listener connection
 *   - `../db/client` — the shared pool used for publish() and logEvent()
 *
 * NO live Postgres connection is required.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── pg mock ──────────────────────────────────────────────────────────────────
//
// EventBus does `new Client({ connectionString })` then calls:
//   client.on('error', ...)
//   client.on('notification', ...)
//   client.connect()
//   client.query(...)     — for LISTEN / UNLISTEN
//   client.end()
//
// We keep a module-level reference to the most-recently-created mock instance
// so individual tests can reach in and trigger 'error' / 'notification' events.

interface MockPgClient {
    on: Mock;
    connect: Mock;
    query: Mock;
    end: Mock;
    /** Fire a registered event handler (error or notification). */
    _emit: (event: 'error' | 'notification', arg: unknown) => void;
}

let latestPgClient: MockPgClient;

function makePgClient(): MockPgClient {
    const handlers = new Map<string, (arg: unknown) => void>();

    const client: MockPgClient = {
        on: vi.fn((event: string, handler: (arg: unknown) => void) => {
            handlers.set(event, handler);
        }),
        connect: vi.fn(async () => undefined),
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        end: vi.fn(async () => undefined),
        _emit(event: 'error' | 'notification', arg: unknown): void {
            const h = handlers.get(event);
            if (h !== undefined) {
                h(arg);
            }
        },
    };

    return client;
}

// vi.mock hoisting: the factory runs before any imports are resolved.
vi.mock('pg', () => {
    return {
        Client: vi.fn(() => {
            latestPgClient = makePgClient();
            return latestPgClient;
        }),
    };
});

// ── db/client mock ────────────────────────────────────────────────────────────

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

// ── Subject under test ────────────────────────────────────────────────────────

import { EventBus, type EventChannel, type EventPayload } from '../../src/orchestrator/event-bus';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a minimal valid publish payload (everything except channel/timestamp). */
function makePublishEvent(
    overrides: Partial<Omit<EventPayload, 'channel' | 'timestamp'>> = {}
): Omit<EventPayload, 'channel' | 'timestamp'> {
    return {
        data: { detail: 'test-value' },
        ...overrides,
    };
}

/**
 * Emit a notification on the current latestPgClient in a way that mirrors
 * what Postgres sends: `{ channel, payload }`.
 */
function emitNotification(notifyChannel: string, payloadObj: EventPayload): void {
    latestPgClient._emit('notification', {
        channel: notifyChannel,
        payload: JSON.stringify(payloadObj),
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EventBus', () => {
    beforeEach(() => {
        mockDb.reset();
        vi.clearAllMocks();
    });

    // ── 1. Constructor ────────────────────────────────────────────────────────

    describe('constructor', () => {
        it('accepts an explicit databaseUrl', () => {
            const bus = new EventBus('postgres://custom:pw@host:5432/db');
            expect(bus).toBeDefined();
        });

        it('falls back to process.env.DATABASE_URL when no url passed', () => {
            const original = process.env.DATABASE_URL;
            process.env.DATABASE_URL = 'postgres://env:env@envhost:5432/envdb';
            const bus = new EventBus();
            expect(bus).toBeDefined();
            process.env.DATABASE_URL = original;
        });

        it('falls back to hardcoded default when neither argument nor env var is set', () => {
            const original = process.env.DATABASE_URL;
            delete process.env.DATABASE_URL;
            const bus = new EventBus();
            expect(bus).toBeDefined();
            process.env.DATABASE_URL = original;
        });

        it('does NOT connect on construction (listenerClient starts null)', async () => {
            const { Client } = await import('pg');
            vi.mocked(Client).mockClear();
            new EventBus('postgres://test:test@localhost/test');
            expect(vi.mocked(Client)).not.toHaveBeenCalled();
        });
    });

    // ── 2. publish() — pg_notify ──────────────────────────────────────────────

    describe('publish() — pg_notify', () => {
        it('calls query() with SELECT pg_notify as the SQL', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('task.created', makePublishEvent());

            const notifyCall = mockDb.query.mock.calls[1] as [string, unknown[]];
            expect(notifyCall[0]).toBe('SELECT pg_notify($1, $2)');
        });

        it('prefixes the notify channel with kageops_ and converts dots to underscores', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('task.created', makePublishEvent());

            const notifyChannel = (mockDb.query.mock.calls[1] as [string, unknown[]])[1][0];
            expect(notifyChannel).toBe('kageops_task_created');
        });

        it('transforms every dot in the channel name to an underscore', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('review.passed', makePublishEvent());

            const notifyChannel = (mockDb.query.mock.calls[1] as [string, unknown[]])[1][0];
            expect(notifyChannel).toBe('kageops_review_passed');
        });

        it('transforms every defined EventChannel to the correct notify channel name', async () => {
            const cases: Array<[EventChannel, string]> = [
                ['task.created',      'kageops_task_created'],
                ['task.assigned',     'kageops_task_assigned'],
                ['task.progress',     'kageops_task_progress'],
                ['task.completed',    'kageops_task_completed'],
                ['task.blocked',      'kageops_task_blocked'],
                ['task.failed',       'kageops_task_failed'],
                ['review.requested',  'kageops_review_requested'],
                ['review.passed',     'kageops_review_passed'],
                ['review.rejected',   'kageops_review_rejected'],
                ['approval.required', 'kageops_approval_required'],
                ['approval.granted',  'kageops_approval_granted'],
                ['approval.denied',   'kageops_approval_denied'],
                ['build.started',     'kageops_build_started'],
                ['build.passed',      'kageops_build_passed'],
                ['build.failed',      'kageops_build_failed'],
                ['agent.benchmark',   'kageops_agent_benchmark'],
            ];

            for (const [channel, expected] of cases) {
                mockDb.reset();
                const bus = new EventBus('postgres://test:test@localhost/test');
                await bus.publish(channel, makePublishEvent());

                const actual = (mockDb.query.mock.calls[1] as [string, unknown[]])[1][0];
                expect(actual).toBe(expected);
            }
        });

        it('serialises the full EventPayload as JSON in the second pg_notify argument', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            const event = makePublishEvent({ projectId: 'proj-1', taskId: 'task-1', agent: 'forge' });
            await bus.publish('task.completed', event);

            const payloadJson = (mockDb.query.mock.calls[1] as [string, unknown[]])[1][1] as string;
            const parsed = JSON.parse(payloadJson) as EventPayload;

            expect(parsed.channel).toBe('task.completed');
            expect(parsed.projectId).toBe('proj-1');
            expect(parsed.taskId).toBe('task-1');
            expect(parsed.agent).toBe('forge');
            expect(parsed.data).toEqual({ detail: 'test-value' });
        });

        it('stamps a valid ISO timestamp on the EventPayload', async () => {
            const before = new Date();
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('build.passed', makePublishEvent());
            const after = new Date();

            const payloadJson = (mockDb.query.mock.calls[1] as [string, unknown[]])[1][1] as string;
            const parsed = JSON.parse(payloadJson) as EventPayload;
            const ts = new Date(parsed.timestamp);

            expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
        });
    });

    // ── 3. publish() — agent_logs insert ─────────────────────────────────────

    describe('publish() — agent_logs insert', () => {
        it('makes exactly two query() calls per publish: INSERT then pg_notify', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('task.created', makePublishEvent());

            expect(mockDb.query).toHaveBeenCalledTimes(2);
        });

        it('first query() is an INSERT INTO agent_logs', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('task.created', makePublishEvent());

            const insertCall = mockDb.query.mock.calls[0] as [string, unknown[]];
            expect(insertCall[0]).toContain('INSERT INTO agent_logs');
        });

        it('logs correct projectId, taskId, agent, action and event_type columns', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            const event = makePublishEvent({ projectId: 'proj-99', taskId: 'task-42', agent: 'vigil' });
            await bus.publish('review.rejected', event);

            const params = (mockDb.query.mock.calls[0] as [string, unknown[]])[1];
            expect(params[0]).toBe('proj-99');                // project_id
            expect(params[1]).toBe('task-42');                // task_id
            expect(params[2]).toBe('vigil');                  // agent
            expect(params[3]).toBe('event:review.rejected');  // action
            expect(params[4]).toBe('review.rejected');        // event_type
        });

        it('defaults agent column to "system" when agent is omitted', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('build.failed', makePublishEvent());

            const params = (mockDb.query.mock.calls[0] as [string, unknown[]])[1];
            expect(params[2]).toBe('system');
        });

        it('logs null for projectId and taskId when they are omitted', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('agent.benchmark', makePublishEvent());

            const params = (mockDb.query.mock.calls[0] as [string, unknown[]])[1];
            expect(params[0]).toBeNull();
            expect(params[1]).toBeNull();
        });

        it('logs event data as a JSON string in the metadata column', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            const event = makePublishEvent({ data: { count: 3, labels: ['x'] } });
            await bus.publish('task.created', event);

            const params = (mockDb.query.mock.calls[0] as [string, unknown[]])[1];
            const metadata = JSON.parse(params[5] as string) as Record<string, unknown>;
            expect(metadata).toEqual({ count: 3, labels: ['x'] });
        });

        it('does NOT throw when the INSERT fails — event flow continues', async () => {
            mockDb.query
                .mockRejectedValueOnce(new Error('DB write error')) // INSERT fails (call 0)
                .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // pg_notify succeeds (call 1)

            const bus = new EventBus('postgres://test:test@localhost/test');
            await expect(bus.publish('task.failed', makePublishEvent())).resolves.toBeUndefined();
        });
    });

    // ── 4. subscribe() ────────────────────────────────────────────────────────

    describe('subscribe()', () => {
        it('adds callback so it receives matching notifications', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const cb = vi.fn();
            await bus.subscribe('task.created', cb);

            const payload: EventPayload = { channel: 'task.created', data: {}, timestamp: new Date().toISOString() };
            emitNotification('kageops_task_created', payload);

            expect(cb).toHaveBeenCalledTimes(1);
            expect(cb).toHaveBeenCalledWith(expect.objectContaining({ channel: 'task.created' }));
        });

        it('supports multiple callbacks on the same channel', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const cb1 = vi.fn();
            const cb2 = vi.fn();
            await bus.subscribe('task.created', cb1);
            await bus.subscribe('task.created', cb2);

            const payload: EventPayload = { channel: 'task.created', data: {}, timestamp: '' };
            emitNotification('kageops_task_created', payload);

            expect(cb1).toHaveBeenCalledTimes(1);
            expect(cb2).toHaveBeenCalledTimes(1);
        });

        it('calls LISTEN on the pg client when subscribing to a new channel with an active connection', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const pgClient = latestPgClient;
            pgClient.query.mockClear(); // discard LISTEN calls from connect()

            await bus.subscribe('build.started', vi.fn());

            const listenCalls = (pgClient.query.mock.calls as [string][])
                .filter(([sql]) => sql.includes('LISTEN'));
            expect(listenCalls).toHaveLength(1);
            expect(listenCalls[0][0]).toBe('LISTEN "kageops_build_started"');
        });

        it('does NOT call LISTEN again for the same channel when a second subscriber is added', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const pgClient = latestPgClient;
            pgClient.query.mockClear();

            await bus.subscribe('task.assigned', vi.fn());
            await bus.subscribe('task.assigned', vi.fn());

            const listenCalls = (pgClient.query.mock.calls as [string][])
                .filter(([sql]) => sql.includes('LISTEN'));
            expect(listenCalls).toHaveLength(1);
        });

        it('does NOT call LISTEN and does NOT create a pg Client when not yet connected', async () => {
            const { Client } = await import('pg');
            vi.mocked(Client).mockClear();

            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.subscribe('task.progress', vi.fn());

            expect(vi.mocked(Client)).not.toHaveBeenCalled();
        });
    });

    // ── 5. subscribeAll() ─────────────────────────────────────────────────────

    describe('subscribeAll()', () => {
        it('adds callback to allSubscribers so it receives any notification', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const allCb = vi.fn();
            bus.subscribeAll(allCb);

            const payload: EventPayload = { channel: 'task.completed', data: {}, timestamp: '' };
            emitNotification('kageops_task_completed', payload);

            expect(allCb).toHaveBeenCalledTimes(1);
            expect(allCb).toHaveBeenCalledWith(expect.objectContaining({ channel: 'task.completed' }));
        });

        it('delivers every notification regardless of which channel it arrived on', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const allCb = vi.fn();
            bus.subscribeAll(allCb);

            const channels: EventChannel[] = ['task.created', 'build.passed', 'review.rejected'];
            for (const channel of channels) {
                const notifyChannel = `kageops_${channel.replace(/\./g, '_')}`;
                const payload: EventPayload = { channel, data: {}, timestamp: '' };
                latestPgClient._emit('notification', { channel: notifyChannel, payload: JSON.stringify(payload) });
            }

            expect(allCb).toHaveBeenCalledTimes(3);
        });

        it('supports multiple all-subscribers registered independently', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const allCb1 = vi.fn();
            const allCb2 = vi.fn();
            bus.subscribeAll(allCb1);
            bus.subscribeAll(allCb2);

            const payload: EventPayload = { channel: 'agent.benchmark', data: {}, timestamp: '' };
            emitNotification('kageops_agent_benchmark', payload);

            expect(allCb1).toHaveBeenCalledTimes(1);
            expect(allCb2).toHaveBeenCalledTimes(1);
        });

        it('same callback added twice is only called once (Set dedup)', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const allCb = vi.fn();
            bus.subscribeAll(allCb);
            bus.subscribeAll(allCb); // duplicate

            const payload: EventPayload = { channel: 'build.started', data: {}, timestamp: '' };
            emitNotification('kageops_build_started', payload);

            expect(allCb).toHaveBeenCalledTimes(1);
        });
    });

    // ── 6. handleNotification() — parsing and dispatch ────────────────────────

    describe('handleNotification() — internal dispatch', () => {
        it('parses the JSON payload and passes a full EventPayload to channel subscribers', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const received: EventPayload[] = [];
            await bus.subscribe('task.blocked', (e) => { received.push(e); });

            const expected: EventPayload = {
                channel: 'task.blocked',
                projectId: 'proj-7',
                taskId: 'task-3',
                agent: 'scout',
                data: { reason: 'waiting' },
                timestamp: '2026-01-01T00:00:00.000Z',
            };
            emitNotification('kageops_task_blocked', expected);

            expect(received).toHaveLength(1);
            expect(received[0]).toEqual(expected);
        });

        it('dispatches to both channel subscribers and all-subscribers', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const channelCb = vi.fn();
            const allCb = vi.fn();
            await bus.subscribe('approval.granted', channelCb);
            bus.subscribeAll(allCb);

            const payload: EventPayload = { channel: 'approval.granted', data: {}, timestamp: '' };
            emitNotification('kageops_approval_granted', payload);

            expect(channelCb).toHaveBeenCalledTimes(1);
            expect(allCb).toHaveBeenCalledTimes(1);
        });

        it('dispatches only to the matching channel — other channels are not called', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const targetCb = vi.fn();
            const otherCb = vi.fn();
            await bus.subscribe('build.passed', targetCb);
            await bus.subscribe('build.failed', otherCb);

            const payload: EventPayload = { channel: 'build.passed', data: {}, timestamp: '' };
            emitNotification('kageops_build_passed', payload);

            expect(targetCb).toHaveBeenCalledTimes(1);
            expect(otherCb).not.toHaveBeenCalled();
        });

        it('does not crash on malformed JSON payload — subscribers not called', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const cb = vi.fn();
            await bus.subscribe('task.created', cb);

            expect(() => {
                latestPgClient._emit('notification', {
                    channel: 'kageops_task_created',
                    payload: '{ this is not json !!!',
                });
            }).not.toThrow();

            expect(cb).not.toHaveBeenCalled();
        });

        it('does not crash on empty string payload', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            expect(() => {
                latestPgClient._emit('notification', {
                    channel: 'kageops_task_created',
                    payload: '',
                });
            }).not.toThrow();
        });

        it('silently ignores notifications whose payload is undefined', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const cb = vi.fn();
            await bus.subscribe('task.created', cb);
            bus.subscribeAll(vi.fn());

            expect(() => {
                latestPgClient._emit('notification', {
                    channel: 'kageops_task_created',
                    payload: undefined,
                });
            }).not.toThrow();

            expect(cb).not.toHaveBeenCalled();
        });

        it('does not crash when a channel subscriber callback rejects asynchronously', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            await bus.subscribe('task.created', async () => {
                throw new Error('Subscriber exploded');
            });

            const payload: EventPayload = { channel: 'task.created', data: {}, timestamp: '' };
            // Source wraps cb(event) in Promise.resolve().catch() — catches async rejections
            expect(() => {
                emitNotification('kageops_task_created', payload);
            }).not.toThrow();

            // Drain microtask queue so the .catch() handler runs
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        it('does not crash when an all-subscriber callback rejects asynchronously', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            bus.subscribeAll(async () => {
                throw new Error('All-subscriber exploded');
            });

            const payload: EventPayload = { channel: 'build.started', data: {}, timestamp: '' };
            expect(() => {
                emitNotification('kageops_build_started', payload);
            }).not.toThrow();

            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        it('still calls remaining subscribers when an earlier one rejects', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const goodCb = vi.fn();
            await bus.subscribe('task.created', async () => { throw new Error('first explodes'); });
            await bus.subscribe('task.created', goodCb);

            const payload: EventPayload = { channel: 'task.created', data: {}, timestamp: '' };
            emitNotification('kageops_task_created', payload);

            // Allow microtask queue to drain so the Promise.resolve().catch() wrappers settle
            await new Promise<void>((resolve) => setTimeout(resolve, 0));

            expect(goodCb).toHaveBeenCalledTimes(1);
        });
    });

    // ── 7. unsubscribe() ──────────────────────────────────────────────────────

    describe('unsubscribe()', () => {
        it('removes the callback so it no longer receives events', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const cb = vi.fn();
            await bus.subscribe('task.failed', cb);
            await bus.unsubscribe('task.failed', cb);

            const payload: EventPayload = { channel: 'task.failed', data: {}, timestamp: '' };
            emitNotification('kageops_task_failed', payload);

            expect(cb).not.toHaveBeenCalled();
        });

        it('calls UNLISTEN on the pg client when the last subscriber is removed', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const cb = vi.fn();
            await bus.subscribe('approval.denied', cb);

            const pgClient = latestPgClient;
            pgClient.query.mockClear();

            await bus.unsubscribe('approval.denied', cb);

            const unlistenCalls = (pgClient.query.mock.calls as [string][])
                .filter(([sql]) => sql.includes('UNLISTEN'));
            expect(unlistenCalls).toHaveLength(1);
            expect(unlistenCalls[0][0]).toBe('UNLISTEN "kageops_approval_denied"');
        });

        it('does NOT call UNLISTEN when other subscribers remain on the channel', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const cb1 = vi.fn();
            const cb2 = vi.fn();
            await bus.subscribe('review.requested', cb1);
            await bus.subscribe('review.requested', cb2);

            const pgClient = latestPgClient;
            pgClient.query.mockClear();

            await bus.unsubscribe('review.requested', cb1);

            const unlistenCalls = (pgClient.query.mock.calls as [string][])
                .filter(([sql]) => sql.includes('UNLISTEN'));
            expect(unlistenCalls).toHaveLength(0);
        });

        it('the remaining subscriber still receives events after a partial unsubscribe', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const cb1 = vi.fn();
            const cb2 = vi.fn();
            await bus.subscribe('review.requested', cb1);
            await bus.subscribe('review.requested', cb2);
            await bus.unsubscribe('review.requested', cb1);

            const payload: EventPayload = { channel: 'review.requested', data: {}, timestamp: '' };
            emitNotification('kageops_review_requested', payload);

            expect(cb1).not.toHaveBeenCalled();
            expect(cb2).toHaveBeenCalledTimes(1);
        });

        it('is a no-op (no error, no UNLISTEN) when the channel has no subscribers', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const pgClient = latestPgClient;
            pgClient.query.mockClear();

            await expect(bus.unsubscribe('task.blocked', vi.fn())).resolves.toBeUndefined();

            const unlistenCalls = (pgClient.query.mock.calls as [string][])
                .filter(([sql]) => sql.includes('UNLISTEN'));
            expect(unlistenCalls).toHaveLength(0);
        });

        it('does NOT attempt UNLISTEN when there is no active listener client', async () => {
            const { Client } = await import('pg');
            vi.mocked(Client).mockClear();

            const bus = new EventBus('postgres://test:test@localhost/test');
            // subscribe without connecting — no pg client created yet
            const cb = vi.fn();
            await bus.subscribe('build.started', cb);
            await bus.unsubscribe('build.started', cb);

            expect(vi.mocked(Client)).not.toHaveBeenCalled();
        });
    });

    // ── 8. disconnect() ───────────────────────────────────────────────────────

    describe('disconnect()', () => {
        it('calls client.end() on the listener connection', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const pgClient = latestPgClient;
            await bus.disconnect();

            expect(pgClient.end).toHaveBeenCalledTimes(1);
        });

        it('sets the closed flag so subsequent error events do not trigger reconnect', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();
            await bus.disconnect();

            const pgClient = latestPgClient;
            pgClient.connect.mockClear();

            // Simulate a connection error arriving after intentional close
            pgClient._emit('error', new Error('post-close error'));

            // Allow any pending timers / microtasks to settle
            await new Promise<void>((resolve) => setTimeout(resolve, 0));

            expect(pgClient.connect).not.toHaveBeenCalled();
        });

        it('is safe to call when connect() was never called', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await expect(bus.disconnect()).resolves.toBeUndefined();
        });

        it('is idempotent — calling disconnect() twice does not throw', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();
            await bus.disconnect();
            await expect(bus.disconnect()).resolves.toBeUndefined();
        });
    });

    // ── 9. connect() ─────────────────────────────────────────────────────────

    describe('connect()', () => {
        it('creates a new pg Client with the configured connection string', async () => {
            const { Client } = await import('pg');
            const bus = new EventBus('postgres://myuser:mypass@myhost:5432/mydb');
            await bus.connect();

            expect(vi.mocked(Client)).toHaveBeenCalledWith({
                connectionString: 'postgres://myuser:mypass@myhost:5432/mydb',
            });
        });

        it('calls client.connect()', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();
            expect(latestPgClient.connect).toHaveBeenCalledTimes(1);
        });

        it('registers "error" and "notification" event handlers on the client', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();

            const onCalls = latestPgClient.on.mock.calls as [string, unknown][];
            const events = onCalls.map(([ev]) => ev);
            expect(events).toContain('error');
            expect(events).toContain('notification');
        });

        it('is idempotent — calling connect() twice creates only one pg Client', async () => {
            const { Client } = await import('pg');
            vi.mocked(Client).mockClear();

            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.connect();
            await bus.connect();

            expect(vi.mocked(Client)).toHaveBeenCalledTimes(1);
        });

        it('re-issues LISTEN for all pre-existing subscriptions when connecting', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');

            // Subscribe BEFORE connecting — no LISTEN can be issued yet
            await bus.subscribe('task.progress', vi.fn());
            await bus.subscribe('build.failed', vi.fn());

            await bus.connect();

            const pgClient = latestPgClient;
            const listenCalls = (pgClient.query.mock.calls as [string][])
                .filter(([sql]) => sql.includes('LISTEN'))
                .map(([sql]) => sql);

            expect(listenCalls).toContain('LISTEN "kageops_task_progress"');
            expect(listenCalls).toContain('LISTEN "kageops_build_failed"');
        });
    });

    // ── 10. EventPayload construction in publish() ────────────────────────────

    describe('EventPayload construction in publish()', () => {
        it('always stamps channel and timestamp regardless of what the caller passes', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('agent.benchmark', { data: {} });

            const payloadJson = (mockDb.query.mock.calls[1] as [string, unknown[]])[1][1] as string;
            const parsed = JSON.parse(payloadJson) as Record<string, unknown>;

            expect(parsed.channel).toBe('agent.benchmark');
            expect(typeof parsed.timestamp).toBe('string');
            expect((parsed.timestamp as string).length).toBeGreaterThan(0);
        });

        it('preserves arbitrary nested data fields from the caller', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('task.completed', {
                projectId: 'proj-x',
                taskId: 'task-y',
                agent: 'blueprint',
                data: { duration: 42, status: 'ok', tags: ['a', 'b'] },
            });

            const payloadJson = (mockDb.query.mock.calls[1] as [string, unknown[]])[1][1] as string;
            const parsed = JSON.parse(payloadJson) as EventPayload;

            expect(parsed.data).toEqual({ duration: 42, status: 'ok', tags: ['a', 'b'] });
        });

        it('does not include projectId, taskId or agent keys when caller omits them', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            await bus.publish('build.started', { data: { step: 'compile' } });

            const payloadJson = (mockDb.query.mock.calls[1] as [string, unknown[]])[1][1] as string;
            const parsed = JSON.parse(payloadJson) as Record<string, unknown>;

            // Optional fields must be absent from JSON — not present as null
            expect('projectId' in parsed).toBe(false);
            expect('taskId' in parsed).toBe(false);
            expect('agent' in parsed).toBe(false);
        });

        it('publish() resolves to undefined (void return)', async () => {
            const bus = new EventBus('postgres://test:test@localhost/test');
            const result = await bus.publish('task.created', makePublishEvent());
            expect(result).toBeUndefined();
        });
    });
});
