/**
 * KageOps Event Bus
 *
 * Postgres LISTEN/NOTIFY pub/sub system for agent communication.
 * All events are typed, logged to agent_logs, and monitored by Sensei.
 */

import { Client } from 'pg';
import { query } from '../db/client';
import { EmbeddedClient, isEmbeddedMode } from '../db/embedded-pg';
import { createLogger } from '../shared/logger';
import { EventPayloadSchema } from '../shared/schemas';

/** Minimal shape shared by pg.Client and EmbeddedClient (what EventBus uses). */
interface ListenClient {
    on(event: 'error', cb: (err: Error) => void): unknown;
    on(event: 'notification', cb: (msg: { channel: string; payload?: string }) => void): unknown;
    connect(): Promise<void>;
    query(sql: string): Promise<unknown>;
    end(): Promise<void>;
}

const log = createLogger('EventBus');

// ── Event Types ──────────────────────────────────────

export type EventChannel =
    | 'task.created'
    | 'task.assigned'
    | 'task.progress'
    | 'task.completed'
    | 'task.blocked'
    | 'task.failed'
    | 'review.requested'
    | 'review.passed'
    | 'review.rejected'
    | 'approval.required'
    | 'approval.granted'
    | 'approval.denied'
    | 'build.started'
    | 'build.passed'
    | 'build.failed'
    | 'cost.warning'
    | 'cost.exceeded'
    | 'agent.benchmark'
    | 'project.created'
    | 'pr.created'
    | 'build.verification.passed'
    | 'build.verification.failed'
    | 'build.verification.warning'
    | 'acceptance.passed'
    | 'acceptance.failed'
    | 'intercept.pause'
    | 'intercept.resume'
    | 'intercept.guidance'
    | 'intercept.takeover'
    | 'intercept.handback'
    | 'intercept.acknowledged'
    | 'agent.stream'
    | 'project.paused'
    | 'project.resumed'
    | 'project.cancelled'
    | 'project.archived'
    | 'project.restored'
    | 'project.deleted'
    | 'project.completed'
    // Resilience signals (v0.12 Track A)
    | 'network.transient'
    | 'eventbus.reconnected'
    // Subprocess output (B-497 — Agent Terminal panel)
    | 'subprocess.output'
    // Task claim / phase transition channels
    | 'task.claimed'
    | 'task.unclaimed'
    | 'phase.changed'
    // Cloud Burst (Pillar 2.4 / PR-E)
    | 'burst.queued'
    | 'burst.provisioning'
    | 'burst.running'
    | 'burst.heartbeat'
    | 'burst.completed'
    | 'burst.failed'
    | 'burst.stopped'
    | 'burst.timeout'
    // Azure Deploy (Pillar 2.5 / PR-F)
    | 'deploy.queued'
    | 'deploy.provisioning'
    | 'deploy.deploying'
    | 'deploy.live'
    | 'deploy.failed'
    | 'deploy.torndown'
    // App-credential setup copilot (MCC-8 / slice 3) — Sensei surfaces
    // just-in-time credential prompts (Stripe/Clerk/DB) to the panel + chat.
    | 'setup.required'
    // BPF-6 — Sensei deferred a development-gate approval; carries the
    // human-readable reason so the Command Center can tell the operator WHY
    // "Approve" didn't advance (instead of silently doing nothing).
    | 'gate.deferred';

export interface EventPayload {
    readonly channel: EventChannel;
    readonly projectId?: string;
    readonly taskId?: string;
    readonly agent?: string;
    readonly data: Record<string, unknown>;
    readonly timestamp: string;
}

export type EventCallback = (event: EventPayload) => void | Promise<void>;

// ── All known channels (for subscribeAll LISTEN registration) ──
const ALL_CHANNELS: readonly EventChannel[] = [
    'task.created', 'task.assigned', 'task.progress', 'task.completed',
    'task.blocked', 'task.failed',
    'review.requested', 'review.passed', 'review.rejected',
    'approval.required', 'approval.granted', 'approval.denied',
    'build.started', 'build.passed', 'build.failed',
    'cost.warning', 'cost.exceeded',
    'agent.benchmark', 'project.created', 'pr.created',
    'build.verification.passed', 'build.verification.failed', 'build.verification.warning',
    'acceptance.passed', 'acceptance.failed',
    'intercept.pause', 'intercept.resume', 'intercept.guidance',
    'intercept.takeover', 'intercept.handback', 'intercept.acknowledged',
    'agent.stream',
    'project.paused', 'project.resumed', 'project.cancelled',
    'project.archived', 'project.restored', 'project.deleted',
    'project.completed',
    'network.transient', 'eventbus.reconnected',
    'subprocess.output',
    'task.claimed', 'task.unclaimed', 'phase.changed',
    // Cloud Burst (Pillar 2.4 / PR-E)
    'burst.queued', 'burst.provisioning', 'burst.running', 'burst.heartbeat',
    'burst.completed', 'burst.failed', 'burst.stopped', 'burst.timeout',
    // Azure Deploy (Pillar 2.5 / PR-F)
    'deploy.queued', 'deploy.provisioning', 'deploy.deploying', 'deploy.live', 'deploy.failed', 'deploy.torndown',
];

// ── Heartbeat / watchdog ────────────────────────────────
// PGlite's embedded LISTEN/NOTIFY loop occasionally goes silent without
// surfacing an error event on the underlying client. We detect this by:
//   1. Publishing an internal `_heartbeat` NOTIFY every 30s.
//   2. A watchdog that flags the bus as dead after 90s of total silence
//      (no heartbeats, no events).
//   3. On dead detection, tear down the listener client and re-subscribe
//      all channels. After recovery, emit `eventbus.reconnected`.

/** Pg NOTIFY channel used for the internal liveness ping. Kept off the
 *  public EventChannel union so consumers don't accidentally subscribe. */
const HEARTBEAT_NOTIFY_CHANNEL = 'kageops_internal_heartbeat';
const HEARTBEAT_INTERVAL_MS = 30_000;
const WATCHDOG_TIMEOUT_MS = 90_000;

// Postgres NOTIFY caps payload at 8000 bytes. Leave headroom for JSON
// quoting overhead added by the libpq wire protocol on external pg.
const NOTIFY_PAYLOAD_LIMIT_BYTES = 7500;

// ── Channel name conversion ──────────────────────────
// Postgres LISTEN/NOTIFY doesn't allow dots — use underscores
function toNotifyChannel(channel: EventChannel): string {
    return `kageops_${channel.replace(/\./g, '_')}`;
}

// PGlite parses text params and rejects NUL bytes with code 22P05.
// External pg accepts them but they break downstream consumers anyway,
// so strip uniformly. Replacement char keeps message length stable
// for the byte-budget check above.
function stripNulBytes(s: string): string {
    return s.includes('\u0000') ? s.replace(/\u0000/g, '�') : s;
}

// ── Event Bus ────────────────────────────────────────

export class EventBus {
    private readonly databaseUrl: string;
    private readonly embedded: boolean;
    private listenerClient: ListenClient | null = null;
    private readonly subscriptions = new Map<string, Set<EventCallback>>();
    private readonly allSubscribers = new Set<EventCallback>();
    private reconnecting = false;
    private closed = false;

    // ── Heartbeat / watchdog state ──────────────────────
    // `lastEventAt` is touched on EVERY incoming NOTIFY (including the
    // internal heartbeat) so the watchdog can detect silent death.
    private lastEventAt: number = Date.now();
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private watchdogTimer: ReturnType<typeof setInterval> | null = null;
    /** Test / dev override: shorten the heartbeat interval. */
    private heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS;
    /** Test / dev override: shorten the watchdog timeout. */
    private watchdogTimeoutMs: number = WATCHDOG_TIMEOUT_MS;

    constructor(databaseUrl?: string) {
        this.embedded = isEmbeddedMode(databaseUrl);
        this.databaseUrl = databaseUrl ?? process.env['DATABASE_URL'] ?? '';
    }

    /**
     * Tune the heartbeat and watchdog intervals. Intended for tests and
     * constrained environments (CI runners with slow event loops).
     * Must be called before `connect()` or the next heartbeat tick to
     * take effect.
     */
    configureLiveness(opts: { readonly heartbeatIntervalMs?: number; readonly watchdogTimeoutMs?: number }): void {
        if (opts.heartbeatIntervalMs !== undefined && opts.heartbeatIntervalMs > 0) {
            this.heartbeatIntervalMs = opts.heartbeatIntervalMs;
        }
        if (opts.watchdogTimeoutMs !== undefined && opts.watchdogTimeoutMs > 0) {
            this.watchdogTimeoutMs = opts.watchdogTimeoutMs;
        }
    }

    /**
     * Connect the listener client for receiving events.
     */
    async connect(): Promise<void> {
        if (this.listenerClient !== null) {
            return;
        }

        this.listenerClient = this.embedded
            ? (new EmbeddedClient() as unknown as ListenClient)
            : (new Client({ connectionString: this.databaseUrl }) as unknown as ListenClient);

        this.listenerClient.on('error', (err: Error) => {
            log.error({ err: err.message }, 'Listener connection error');
            this.handleReconnect();
        });

        this.listenerClient.on('notification', (msg) => {
            this.handleNotification(msg);
        });

        await this.listenerClient.connect();
        log.info({ mode: this.embedded ? 'embedded' : 'external' }, 'Listener connected.');

        // Always LISTEN on the internal heartbeat channel first — this is
        // how the watchdog detects a silently-dead pg LISTEN loop.
        await this.listenerClient.query(`LISTEN "${HEARTBEAT_NOTIFY_CHANNEL}"`);

        // Re-subscribe to any existing channels
        for (const channel of this.subscriptions.keys()) {
            await this.listenerClient.query(`LISTEN "${channel}"`);
        }

        // If subscribeAll has been called, LISTEN on ALL known channels
        // so that Sensei (and any all-event subscriber) receives every event type.
        if (this.allSubscribers.size > 0) {
            await this.listenAllChannels();
        }

        // Reset the watchdog clock and start the heartbeat + watchdog.
        this.lastEventAt = Date.now();
        this.startLivenessTimers();
    }

    /**
     * Register LISTEN on every known event channel.
     * Called when subscribeAll is active so no events are missed.
     */
    private async listenAllChannels(): Promise<void> {
        if (this.listenerClient === null) return;
        for (const channel of ALL_CHANNELS) {
            const notifyChannel = toNotifyChannel(channel);
            if (!this.subscriptions.has(notifyChannel)) {
                await this.listenerClient.query(`LISTEN "${notifyChannel}"`);
            }
        }
    }

    /**
     * Publish an event to a channel.
     * Uses the shared pool (not the listener connection) for sending.
     * Also logs the event to agent_logs table.
     */
    async publish(channel: EventChannel, event: Omit<EventPayload, 'channel' | 'timestamp'>): Promise<void> {
        const fullEvent: EventPayload = {
            ...event,
            channel,
            timestamp: new Date().toISOString(),
        };

        const notifyChannel = toNotifyChannel(channel);

        // Always log the full event first — agent_logs is the audit trail
        // and must not be dropped if NOTIFY fails (e.g. payload too long).
        await this.logEvent(fullEvent);

        // Postgres NOTIFY caps payloads at ~8000 bytes. If the serialized
        // event exceeds that, swap `data` for a truncation marker so live
        // subscribers still get routed (channel/project/task/agent), and
        // can fetch the full record from agent_logs if needed.
        const safePayload = this.toNotifyPayload(fullEvent);

        try {
            await query('SELECT pg_notify($1, $2)', [notifyChannel, safePayload]);
        } catch (err) {
            // Don't let a NOTIFY failure crash the caller — the event is
            // already in agent_logs. Surface it for diagnostics only.
            log.warn(
                { err: err instanceof Error ? err.message : String(err), channel, taskId: event.taskId },
                'pg_notify failed (event still logged to agent_logs)'
            );
        }
    }

    /**
     * Build a NOTIFY-safe payload. If the serialized event would exceed
     * the Postgres NOTIFY limit, replace the `data` field with a small
     * truncation marker so routing metadata still propagates.
     */
    private toNotifyPayload(event: EventPayload): string {
        // Strip NUL bytes — PGlite rejects   in text params with
        // 22P05 ("unsupported Unicode escape sequence"). Streamed agent
        // output and pasted tool results occasionally carry stray nulls;
        // the audit copy in agent_logs keeps the original bytes.
        const full = stripNulBytes(JSON.stringify(event));
        if (Buffer.byteLength(full, 'utf8') <= NOTIFY_PAYLOAD_LIMIT_BYTES) {
            return full;
        }

        const truncated: EventPayload = {
            ...event,
            data: {
                truncated: true,
                reason: 'payload exceeds pg_notify limit; full record in agent_logs',
                originalSize: Buffer.byteLength(full, 'utf8'),
            },
        };
        return stripNulBytes(JSON.stringify(truncated));
    }

    /**
     * Subscribe to a specific event channel.
     */
    async subscribe(channel: EventChannel, callback: EventCallback): Promise<void> {
        const notifyChannel = toNotifyChannel(channel);

        const existing = this.subscriptions.get(notifyChannel);
        if (existing !== undefined) {
            // Channel already has subscribers — just add the new callback
            const updated = new Set(existing);
            updated.add(callback);
            this.subscriptions.set(notifyChannel, updated);
        } else {
            // New channel — subscribe and listen
            this.subscriptions.set(notifyChannel, new Set([callback]));
            if (this.listenerClient !== null) {
                await this.listenerClient.query(`LISTEN "${notifyChannel}"`);
            }
        }
    }

    /**
     * Subscribe to ALL events (used by Sensei).
     */
    subscribeAll(callback: EventCallback): void {
        const wasEmpty = this.allSubscribers.size === 0;
        this.allSubscribers.add(callback);

        // If we're already connected and this is the first subscribeAll, register LISTENs
        if (wasEmpty && this.listenerClient !== null) {
            void this.listenAllChannels().catch((err) => {
                log.error({ err }, 'Failed to register LISTEN for all channels');
            });
        }
    }

    /**
     * Unsubscribe from a channel.
     */
    async unsubscribe(channel: EventChannel, callback: EventCallback): Promise<void> {
        const notifyChannel = toNotifyChannel(channel);
        const subscribers = this.subscriptions.get(notifyChannel);

        if (subscribers === undefined) {
            return;
        }

        const updated = new Set(subscribers);
        updated.delete(callback);

        if (updated.size === 0) {
            this.subscriptions.delete(notifyChannel);
            if (this.listenerClient !== null) {
                await this.listenerClient.query(`UNLISTEN "${notifyChannel}"`);
            }
        } else {
            this.subscriptions.set(notifyChannel, updated);
        }
    }

    /**
     * Unsubscribe from all events.
     */
    unsubscribeAll(callback: EventCallback): void {
        this.allSubscribers.delete(callback);
    }

    /**
     * Gracefully disconnect.
     */
    async disconnect(): Promise<void> {
        this.closed = true;
        this.stopLivenessTimers();
        if (this.listenerClient !== null) {
            try {
                await this.listenerClient.end();
            } catch (err) {
                // Never let a flaky close error escape — we're shutting down.
                log.warn({ err }, 'Error while closing listener client');
            }
            this.listenerClient = null;
            log.info('Disconnected.');
        }
    }

    // ── Liveness (heartbeat + watchdog) ────────────────

    private startLivenessTimers(): void {
        this.stopLivenessTimers();

        // Heartbeat: self-publish a tiny NOTIFY we're listening on.
        this.heartbeatTimer = setInterval(() => {
            void this.sendHeartbeat();
        }, this.heartbeatIntervalMs);
        // Allow Node to exit while the bus is idle — matches existing
        // KageOps scheduler convention.
        const hb = this.heartbeatTimer as unknown as { unref?: () => void };
        if (typeof hb.unref === 'function') hb.unref();

        // Watchdog: periodic poll on a fraction of the timeout so we
        // detect silent death without over-spending on timers.
        const watchdogTick = Math.max(1_000, Math.floor(this.watchdogTimeoutMs / 3));
        this.watchdogTimer = setInterval(() => {
            this.runWatchdog();
        }, watchdogTick);
        const wd = this.watchdogTimer as unknown as { unref?: () => void };
        if (typeof wd.unref === 'function') wd.unref();
    }

    private stopLivenessTimers(): void {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.watchdogTimer !== null) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }

    private async sendHeartbeat(): Promise<void> {
        if (this.closed || this.reconnecting) return;
        try {
            // Parameterized pg_notify: keeps SQL injection impossible and
            // matches the pattern used by publish().
            await query('SELECT pg_notify($1, $2)', [HEARTBEAT_NOTIFY_CHANNEL, '']);
        } catch (err) {
            // A failing pg_notify itself counts as evidence the bus is
            // unhealthy — let the watchdog pick it up on the next tick.
            log.warn({ err }, 'Heartbeat publish failed');
        }
    }

    private runWatchdog(): void {
        if (this.closed || this.reconnecting || this.listenerClient === null) return;
        const silentMs = Date.now() - this.lastEventAt;
        if (silentMs < this.watchdogTimeoutMs) return;

        log.error(
            { silentMs, thresholdMs: this.watchdogTimeoutMs },
            '[EventBus] The bus has gone quiet — tearing down listener and resubscribing'
        );
        this.handleReconnect();
    }

    // ── Private ──────────────────────────────────────

    private handleNotification(msg: { channel: string; payload?: string }): void {
        // ANY inbound NOTIFY proves the listener loop is alive — reset the
        // watchdog clock before we do anything else (parse errors, schema
        // mismatches, or internal heartbeats all still count as liveness).
        this.lastEventAt = Date.now();

        // Internal heartbeat short-circuits here — it isn't a real event.
        if (msg.channel === HEARTBEAT_NOTIFY_CHANNEL) {
            return;
        }

        if (msg.payload === undefined) {
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(msg.payload);
        } catch {
            log.warn({ payload: msg.payload }, 'Failed to parse notification payload');
            return;
        }

        const result = EventPayloadSchema.safeParse(parsed);
        if (!result.success) {
            log.warn(
                { payload: msg.payload, errors: result.error.flatten() },
                'Malformed event payload — skipping'
            );
            return;
        }

        const event: EventPayload = result.data;

        // Notify channel-specific subscribers
        const subscribers = this.subscriptions.get(msg.channel);
        if (subscribers !== undefined) {
            for (const cb of subscribers) {
                void Promise.resolve(cb(event)).catch((err) => {
                    log.error({ err }, 'Subscriber error');
                });
            }
        }

        // Notify all-event subscribers (Sensei)
        for (const cb of this.allSubscribers) {
            void Promise.resolve(cb(event)).catch((err) => {
                log.error({ err }, 'All-subscriber error');
            });
        }
    }

    private async logEvent(event: EventPayload): Promise<void> {
        try {
            // PGlite parses JSON columns server-side and rejects \u0000
            // there even though plain text params accept it. Strip NULs
            // from the metadata JSON before insert. Same rationale as
            // toNotifyPayload (commit 40a79c7).
            await query(
                `INSERT INTO agent_logs (project_id, task_id, agent, action, event_type, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    event.projectId ?? null,
                    event.taskId ?? null,
                    event.agent ?? 'system',
                    `event:${event.channel}`,
                    event.channel,
                    stripNulBytes(JSON.stringify(event.data)),
                ]
            );
        } catch (err) {
            // Don't let logging failures break the event flow
            log.warn({ err }, 'Failed to log event');
        }
    }

    private handleReconnect(): void {
        if (this.reconnecting || this.closed) {
            return;
        }

        this.reconnecting = true;

        // Stop timers and attempt a clean tear-down of the stale listener
        // client. If the underlying pg client is already wedged, `.end()`
        // may throw — swallow it, we're about to discard this client.
        this.stopLivenessTimers();
        if (this.listenerClient !== null) {
            const stale = this.listenerClient;
            this.listenerClient = null;
            void Promise.resolve()
                .then(() => stale.end())
                .catch((err) => log.warn({ err }, 'Stale listener end() threw'));
        }

        log.info('Attempting reconnect in 3s...');
        setTimeout(() => { void this.attemptReconnect(); }, 3000);
    }

    private async attemptReconnect(): Promise<void> {
        if (this.closed) {
            this.reconnecting = false;
            return;
        }
        try {
            await this.connect();
            this.reconnecting = false;
            log.info('Reconnected successfully.');
            // Surface the recovery so the UI and Sensei can log it.
            try {
                await this.publish('eventbus.reconnected', {
                    agent: 'system',
                    data: { recoveredAt: new Date().toISOString() },
                });
            } catch (err) {
                log.warn({ err }, 'Failed to publish eventbus.reconnected');
            }
        } catch (err) {
            this.reconnecting = false;
            log.error({ err }, 'Reconnect failed');
            // Try again
            this.handleReconnect();
        }
    }
}
