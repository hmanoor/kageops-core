/**
 * EventBus heartbeat + watchdog tests (v0.12 Track A)
 *
 * Verifies that:
 *   1. A heartbeat is published on the configured interval.
 *   2. An inbound heartbeat NOTIFY resets the watchdog clock.
 *   3. When the bus goes silent for watchdogTimeoutMs, the listener
 *      client is torn down and `.connect()` is called again.
 *   4. After recovery, `eventbus.reconnected` is published.
 *
 * Both pg.Client (external) and db/client (shared pool) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ── pg mock ──────────────────────────────────────────────────────────────────

interface MockPgClient {
    on: Mock;
    connect: Mock;
    query: Mock;
    end: Mock;
    _emit: (event: 'error' | 'notification', arg: unknown) => void;
}

let latestPgClient: MockPgClient;
let allPgClients: MockPgClient[] = [];

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
            if (h !== undefined) h(arg);
        },
    };
    return client;
}

vi.mock('pg', () => ({
    Client: vi.fn(() => {
        latestPgClient = makePgClient();
        allPgClients.push(latestPgClient);
        return latestPgClient;
    }),
}));

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

import { EventBus } from '../../src/orchestrator/event-bus';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function flushMicrotasks(): Promise<void> {
    // Drain pending microtasks without advancing fake timers.
    await Promise.resolve();
    await Promise.resolve();
}

describe('EventBus — heartbeat + watchdog', () => {
    beforeEach(() => {
        mockDb.reset();
        vi.clearAllMocks();
        allPgClients = [];
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('publishes a heartbeat NOTIFY on the configured interval', async () => {
        const bus = new EventBus('postgres://test:test@localhost/test');
        bus.configureLiveness({ heartbeatIntervalMs: 1_000, watchdogTimeoutMs: 10_000 });
        await bus.connect();

        expect(mockDb.query).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);
        await flushMicrotasks();

        // First heartbeat should have fired.
        const heartbeatCalls = mockDb.query.mock.calls.filter(
            (c) => (c as unknown as [string, unknown[]])[1][0] === 'kageops_internal_heartbeat'
        );
        expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);

        await bus.disconnect();
    });

    it('LISTEN is registered on the internal heartbeat channel at connect time', async () => {
        const bus = new EventBus('postgres://test:test@localhost/test');
        bus.configureLiveness({ heartbeatIntervalMs: 60_000, watchdogTimeoutMs: 120_000 });
        await bus.connect();

        const listenCalls = latestPgClient.query.mock.calls.map(
            (c) => (c as unknown as [string])[0]
        );
        expect(listenCalls).toContain('LISTEN "kageops_internal_heartbeat"');

        await bus.disconnect();
    });

    it('resets the watchdog clock when a heartbeat notification arrives', async () => {
        const bus = new EventBus('postgres://test:test@localhost/test');
        bus.configureLiveness({ heartbeatIntervalMs: 1_000, watchdogTimeoutMs: 3_000 });
        await bus.connect();

        const firstClient = latestPgClient;
        const initialConnects = vi.mocked(firstClient.connect).mock.calls.length;

        // Advance past the would-be deadline, but emit a heartbeat just before
        // it to prove it resets the timer.
        await vi.advanceTimersByTimeAsync(2_000);
        firstClient._emit('notification', { channel: 'kageops_internal_heartbeat', payload: '' });
        await vi.advanceTimersByTimeAsync(2_000);
        await flushMicrotasks();

        // No reconnection should have happened — client is still alive.
        expect(allPgClients.length).toBe(1);
        expect(vi.mocked(firstClient.connect).mock.calls.length).toBe(initialConnects);

        await bus.disconnect();
    });

    it('heartbeat NOTIFY short-circuits before schema validation', async () => {
        const bus = new EventBus('postgres://test:test@localhost/test');
        bus.configureLiveness({ heartbeatIntervalMs: 60_000, watchdogTimeoutMs: 120_000 });

        const received: unknown[] = [];
        bus.subscribeAll((e) => { received.push(e); });
        await bus.connect();

        // Empty payload on heartbeat channel — schema would reject this as
        // a normal event but must not warn for the internal channel.
        latestPgClient._emit('notification', {
            channel: 'kageops_internal_heartbeat',
            payload: '',
        });

        expect(received.length).toBe(0);
        await bus.disconnect();
    });

    it('detects silent death, tears down the listener, and reconnects', async () => {
        const bus = new EventBus('postgres://test:test@localhost/test');
        bus.configureLiveness({ heartbeatIntervalMs: 60_000, watchdogTimeoutMs: 200 });
        await bus.connect();

        const firstClient = latestPgClient;
        expect(allPgClients.length).toBe(1);

        // Advance far enough to trip the watchdog poll, then drain the
        // 3s reconnect delay. Flush microtasks generously so each `await`
        // chain inside handleReconnect / attemptReconnect / connect can
        // complete before we assert.
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await flushMicrotasks();
        }

        // Old client should have been ended and a new one instantiated.
        expect(vi.mocked(firstClient.end)).toHaveBeenCalled();
        expect(allPgClients.length).toBeGreaterThanOrEqual(2);

        await bus.disconnect();
    });

    it('publishes eventbus.reconnected after a successful recovery', async () => {
        const bus = new EventBus('postgres://test:test@localhost/test');
        bus.configureLiveness({ heartbeatIntervalMs: 60_000, watchdogTimeoutMs: 200 });
        await bus.connect();

        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await flushMicrotasks();
        }

        const reconnectCalls = mockDb.query.mock.calls.filter(
            (c) => (c as unknown as [string, unknown[]])[1][0] === 'kageops_eventbus_reconnected'
        );
        expect(reconnectCalls.length).toBeGreaterThanOrEqual(1);

        await bus.disconnect();
    });

    it('does NOT reconnect after disconnect() has been called', async () => {
        const bus = new EventBus('postgres://test:test@localhost/test');
        bus.configureLiveness({ heartbeatIntervalMs: 60_000, watchdogTimeoutMs: 200 });
        await bus.connect();
        await bus.disconnect();

        const clientsAtDisconnect = allPgClients.length;

        // Even if time passes, no new client should spin up.
        await vi.advanceTimersByTimeAsync(10_000);
        await flushMicrotasks();

        expect(allPgClients.length).toBe(clientsAtDisconnect);
    });
});
