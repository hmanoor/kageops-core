/**
 * Reusable mock factory for the EventBus.
 *
 * Captures published events and allows triggering events
 * for testing subscribers.
 */

import { vi } from 'vitest';

// ── Types ────────────────────────────────────────────

export interface PublishedEvent {
    readonly channel: string;
    readonly event: {
        readonly projectId?: string;
        readonly taskId?: string;
        readonly agent?: string;
        readonly data: Record<string, unknown>;
    };
}

export interface MockEventBus {
    readonly connect: ReturnType<typeof vi.fn>;
    readonly publish: ReturnType<typeof vi.fn>;
    readonly subscribe: ReturnType<typeof vi.fn>;
    readonly subscribeAll: ReturnType<typeof vi.fn>;
    readonly unsubscribe: ReturnType<typeof vi.fn>;
    readonly unsubscribeAll: ReturnType<typeof vi.fn>;
    readonly disconnect: ReturnType<typeof vi.fn>;
    readonly publishedEvents: readonly PublishedEvent[];
    readonly subscriptions: Map<string, Set<(event: unknown) => void>>;
    readonly allSubscribers: Set<(event: unknown) => void>;
    readonly triggerEvent: (channel: string, payload: Record<string, unknown>) => Promise<void>;
    readonly reset: () => void;
}

// ── Factory ─────────────────────────────────────────

/**
 * Create a mock EventBus that captures all published events
 * and allows triggering events for subscriber testing.
 */
export function createMockEventBus(): MockEventBus {
    const publishedEvents: PublishedEvent[] = [];
    const subscriptions = new Map<string, Set<(event: unknown) => void>>();
    const allSubscribers = new Set<(event: unknown) => void>();

    const connectFn = vi.fn(async () => undefined);

    const publishFn = vi.fn(async (channel: string, event: Record<string, unknown>) => {
        publishedEvents.push({ channel, event: event as PublishedEvent['event'] });
    });

    const subscribeFn = vi.fn(async (channel: string, callback: (event: unknown) => void) => {
        const existing = subscriptions.get(channel);
        if (existing !== undefined) {
            existing.add(callback);
        } else {
            subscriptions.set(channel, new Set([callback]));
        }
    });

    const subscribeAllFn = vi.fn((callback: (event: unknown) => void) => {
        allSubscribers.add(callback);
    });

    const unsubscribeFn = vi.fn(async (channel: string, callback: (event: unknown) => void) => {
        const subs = subscriptions.get(channel);
        if (subs !== undefined) {
            subs.delete(callback);
            if (subs.size === 0) {
                subscriptions.delete(channel);
            }
        }
    });

    const unsubscribeAllFn = vi.fn((callback: (event: unknown) => void) => {
        allSubscribers.delete(callback);
    });

    const disconnectFn = vi.fn(async () => undefined);

    const triggerEvent = async (channel: string, payload: Record<string, unknown>): Promise<void> => {
        const fullPayload = { channel, timestamp: new Date().toISOString(), ...payload };

        // Notify channel-specific subscribers
        const subs = subscriptions.get(channel);
        if (subs !== undefined) {
            for (const cb of subs) {
                await cb(fullPayload);
            }
        }

        // Notify all-event subscribers
        for (const cb of allSubscribers) {
            await cb(fullPayload);
        }
    };

    const reset = (): void => {
        publishedEvents.length = 0;
        subscriptions.clear();
        allSubscribers.clear();
        connectFn.mockClear();
        publishFn.mockClear();
        subscribeFn.mockClear();
        subscribeAllFn.mockClear();
        unsubscribeFn.mockClear();
        unsubscribeAllFn.mockClear();
        disconnectFn.mockClear();
    };

    return {
        connect: connectFn,
        publish: publishFn,
        subscribe: subscribeFn,
        subscribeAll: subscribeAllFn,
        unsubscribe: unsubscribeFn,
        unsubscribeAll: unsubscribeAllFn,
        disconnect: disconnectFn,
        get publishedEvents() { return [...publishedEvents]; },
        subscriptions,
        allSubscribers,
        triggerEvent,
        reset,
    };
}
