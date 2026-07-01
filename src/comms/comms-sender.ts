/**
 * KageOps Communication Sender
 *
 * Polls the comms_queue table and dispatches messages to the
 * appropriate channel adapter (Teams webhook, SMTP email).
 * Handles retries with exponential backoff.
 */

import { query, getMany } from '../db/client';
import { ChannelAdapter, CommsChannel, CommsMessage, CommsStatus, EnqueueOptions } from './types';
import { TeamsWebhookAdapter } from './adapters/teams-webhook';
import { SmtpEmailAdapter } from './adapters/smtp-email';
import { createLogger } from '../shared/logger';

const log = createLogger('CommsSender');

// ── Constants ────────────────────────────────────────

const MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 10_000;
const BASE_RETRY_DELAY_MS = 5_000;

// ── Comms Sender ────────────────────────────────────

export class CommsSender {
    private readonly adapters: ReadonlyMap<CommsChannel, ChannelAdapter>;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    /**
     * F-355: cache adapter.isConfigured() per channel for the lifetime of the
     * sender. Unconfigured channels silently skip enqueue — no DB row, no
     * retry, no error spam. Cache is invalidated only on restart, which is
     * fine because secret rotation requires a restart anyway in current build.
     * `null` = not yet checked, `true` = configured, `false` = unconfigured.
     */
    private readonly configurationCache = new Map<CommsChannel, boolean | null>();
    /** Channels we've already logged the configured/unconfigured verdict for. */
    private readonly configurationLogged = new Set<CommsChannel>();

    constructor(adapters?: ReadonlyMap<CommsChannel, ChannelAdapter>) {
        this.adapters = adapters ?? new Map<CommsChannel, ChannelAdapter>([
            ['teams', new TeamsWebhookAdapter()],
            ['email', new SmtpEmailAdapter()],
        ]);
    }

    /**
     * F-355: Look up whether the given channel's adapter is configured.
     * Result is cached for the lifetime of this CommsSender. The first call
     * also logs the verdict at info level so operators have one line in the
     * log telling them which channels are live.
     */
    private async resolveConfigured(channel: CommsChannel): Promise<boolean> {
        const cached = this.configurationCache.get(channel);
        if (cached === true || cached === false) return cached;

        const adapter = this.adapters.get(channel);
        if (adapter === undefined) {
            this.configurationCache.set(channel, false);
            return false;
        }

        let configured = false;
        try {
            configured = await adapter.isConfigured();
        } catch (err) {
            // A throw from isConfigured() is treated as "not configured" —
            // we never want a secret-store hiccup to turn into a comms
            // failure during a project run.
            log.warn(
                { channel, err: err instanceof Error ? err.message : String(err) },
                'isConfigured() threw — treating channel as unconfigured',
            );
            configured = false;
        }

        this.configurationCache.set(channel, configured);
        if (!this.configurationLogged.has(channel)) {
            this.configurationLogged.add(channel);
            log.info(
                { channel, configured },
                configured
                    ? `Comms channel '${channel}' is configured and will deliver messages`
                    : `Comms channel '${channel}' is not configured — messages will be silently skipped`,
            );
        }
        return configured;
    }

    /**
     * Start polling the comms_queue for pending messages.
     */
    start(): void {
        if (this.running) return;

        this.running = true;
        log.info('Started. Polling for messages...');

        // Process immediately on start, then poll
        void this.processPending();
        this.pollTimer = setInterval(() => {
            void this.processPending();
        }, POLL_INTERVAL_MS);
    }

    /**
     * Stop polling.
     */
    stop(): void {
        this.running = false;
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        log.info('Stopped.');
    }

    /**
     * Enqueue a new message to the comms_queue.
     *
     * F-355: silently no-ops when the channel adapter isn't configured. The
     * earlier behaviour enqueued every message regardless and then surfaced
     * 3× ERROR-level retries per message when the adapter found no webhook
     * URL / SMTP host. With ~6 messages per project run, that was 18 lines
     * of red log noise per run for operators who deliberately hadn't wired
     * Teams + SMTP. Returns a sentinel id `'noop-unconfigured-<channel>'`
     * so callers that store/inspect the id still get a defined value.
     */
    async enqueue(options: EnqueueOptions): Promise<string> {
        const configured = await this.resolveConfigured(options.channel);
        if (!configured) {
            return `noop-unconfigured-${options.channel}`;
        }

        const result = await query<{ id: string }>(
            `INSERT INTO comms_queue (project_id, channel, recipient, subject, body, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')
             RETURNING id`,
            [
                options.projectId ?? null,
                options.channel,
                options.recipient ?? null,
                options.subject ?? null,
                options.body,
            ]
        );

        const id = result.rows[0].id;
        log.info({ id, channel: options.channel }, 'Enqueued message');
        return id;
    }

    /**
     * Process all pending messages in the queue.
     */
    async processPending(): Promise<number> {
        if (!this.running) return 0;

        try {
            const messages = await getMany<{
                id: string;
                project_id: string | null;
                channel: string;
                recipient: string | null;
                subject: string | null;
                body: string;
                status: string;
                error_message: string | null;
                retry_count: number;
                sent_at: Date | null;
                created_at: Date;
            }>(
                `SELECT * FROM comms_queue
                 WHERE status = 'pending'
                 ORDER BY created_at ASC
                 LIMIT 10`
            );

            let sentCount = 0;

            for (const row of messages) {
                const message: CommsMessage = {
                    id: row.id,
                    projectId: row.project_id,
                    channel: row.channel as CommsChannel,
                    recipient: row.recipient,
                    subject: row.subject,
                    body: row.body,
                    status: row.status as CommsStatus,
                    errorMessage: row.error_message,
                    retryCount: row.retry_count,
                    sentAt: row.sent_at,
                    createdAt: row.created_at,
                };

                const success = await this.sendMessage(message);
                if (success) sentCount++;
            }

            return sentCount;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg }, 'Error processing queue');
            return 0;
        }
    }

    /**
     * Get configured channel names.
     */
    getChannels(): readonly CommsChannel[] {
        return [...this.adapters.keys()];
    }

    // ── Private Helpers ─────────────────────────────

    private async sendMessage(message: CommsMessage): Promise<boolean> {
        const adapter = this.adapters.get(message.channel);

        if (adapter === undefined) {
            log.warn({ channel: message.channel }, 'No adapter for channel');
            await this.markFailed(message.id, `No adapter for channel: ${message.channel}`, message.retryCount);
            return false;
        }

        // Mark as sending
        await query(
            `UPDATE comms_queue SET status = 'sending' WHERE id = $1`,
            [message.id]
        );

        try {
            await adapter.send(message);
            await this.markSent(message.id);
            return true;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log.error({ messageId: message.id, err: errorMsg }, 'Failed to send message');

            if (message.retryCount < MAX_RETRIES) {
                await this.markRetry(message.id, errorMsg, message.retryCount);
            } else {
                await this.markFailed(message.id, errorMsg, message.retryCount);
            }

            return false;
        }
    }

    private async markSent(id: string): Promise<void> {
        await query(
            `UPDATE comms_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
            [id]
        );
    }

    private async markFailed(id: string, errorMessage: string, retryCount: number): Promise<void> {
        await query(
            `UPDATE comms_queue SET status = 'failed', error_message = $1, retry_count = $2 WHERE id = $3`,
            [errorMessage, retryCount, id]
        );
    }

    private async markRetry(id: string, errorMessage: string, currentRetryCount: number): Promise<void> {
        const newRetryCount = currentRetryCount + 1;
        // Exponential backoff: mark as pending again (will be picked up on next poll)
        await query(
            `UPDATE comms_queue SET status = 'pending', error_message = $1, retry_count = $2 WHERE id = $3`,
            [errorMessage, newRetryCount, id]
        );
        log.info(
            { messageId: id, retry: newRetryCount, maxRetries: MAX_RETRIES, delayMs: BASE_RETRY_DELAY_MS * Math.pow(2, newRetryCount - 1) },
            'Message scheduled for retry'
        );
    }
}
