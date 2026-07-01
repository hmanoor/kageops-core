/**
 * KageOps Activity Bridge
 *
 * Bridges EventBus events to the Command Center renderer via IPC.
 * Subscribes to all orchestration events and pushes them to the
 * Command Center window in real-time.
 */

import type { BrowserWindow } from 'electron';
import type { EventBus, EventPayload, EventChannel } from '../orchestrator/event-bus';
import { createLogger } from '../shared/logger';

const log = createLogger('ActivityBridge');

// ── Types ────────────────────────────────────────────

export interface ActivityEvent {
    readonly time: string;
    readonly agent: string;
    readonly channel: string;
    readonly message: string;
    readonly projectId?: string;
    readonly taskId?: string;
    readonly severity: 'info' | 'warning' | 'error';
    /** Raw event payload (data field from EventPayload). Optional — present
     *  for events where the renderer wants to drill into details
     *  (e.g. agent.stream prompt+response). */
    readonly data?: unknown;
}

export interface ActivityBridgeConfig {
    readonly eventBus: EventBus;
    readonly getWindow: () => BrowserWindow | null;
}

// ── Constants ────────────────────────────────────────

/** Channels the bridge subscribes to for activity feed. */
const ACTIVITY_CHANNELS: readonly EventChannel[] = [
    'task.created',
    'task.assigned',
    'task.progress',
    'task.completed',
    'task.failed',
    'task.blocked',
    'review.requested',
    'review.passed',
    'review.rejected',
    'approval.required',
    'approval.granted',
    'approval.denied',
    'build.started',
    'build.passed',
    'build.failed',
    'cost.warning',
    'cost.exceeded',
    'intercept.acknowledged',
    // Agent AI exchange — published by every askAI call. Routed into
    // Mission Control's activity feed so users can click into a row
    // and see the full prompt + response without switching to the
    // Autonauts dossier view.
    'agent.stream',
];

/** Channels that trigger agent status updates. */
const AGENT_STATUS_CHANNELS: ReadonlySet<EventChannel> = new Set([
    'task.assigned',
    'task.completed',
    'task.failed',
    'task.progress',
]);

/** Channels that trigger project status updates. */
const PROJECT_STATUS_CHANNELS: ReadonlySet<EventChannel> = new Set([
    'task.completed',
    'approval.required',
    'approval.granted',
    'approval.denied',
    'project.paused',
    'project.resumed',
    'project.cancelled',
    'project.archived',
    'project.restored',
]);

// ── Activity Bridge ──────────────────────────────────

export class ActivityBridge {
    private config: ActivityBridgeConfig | null = null;
    private running = false;

    /**
     * Start the bridge — subscribe to EventBus and push to renderer.
     */
    start(config: ActivityBridgeConfig): void {
        if (this.running) return;

        this.config = config;
        this.running = true;

        // Subscribe to each channel individually (not subscribeAll)
        // so we can control exactly which events reach the UI
        for (const channel of ACTIVITY_CHANNELS) {
            void config.eventBus.subscribe(channel, (event) => {
                this.onEvent(event);
            });
        }

        // Subscribe to agent.stream separately — forwarded to a dedicated IPC channel
        void config.eventBus.subscribe('agent.stream', (event) => {
            this.onStreamEvent(event);
        });

        // Subscribe to intercept acks for dedicated forwarding
        void config.eventBus.subscribe('intercept.acknowledged', (event) => {
            this.onInterceptAck(event);
        });

        log.info('Started. Streaming events to Command Center.');
    }

    /**
     * Stop the bridge.
     */
    stop(): void {
        this.running = false;
        this.config = null;
        log.info('Stopped.');
    }

    /**
     * Push a custom activity event directly to the Command Center.
     * Use this for events that don't originate from the EventBus
     * (e.g. Sensei chat, character sessions, system lifecycle).
     */
    pushActivity(event: {
        readonly agent: string;
        readonly message: string;
        readonly severity?: 'info' | 'warning' | 'error';
        readonly channel?: string;
    }): void {
        if (!this.running || this.config === null) return;

        const win = this.config.getWindow();
        if (win === null || win.isDestroyed()) return;

        const activityEvent: ActivityEvent = {
            time: new Date().toISOString(),
            agent: event.agent,
            channel: event.channel ?? 'system.info',
            message: event.message,
            severity: event.severity ?? 'info',
        };

        try {
            win.webContents.send('command-center:activity-event', activityEvent);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg }, 'pushActivity IPC send failed');
        }
    }

    // ── Private Helpers ──────────────────────────────

    private onEvent(event: EventPayload): void {
        if (!this.running || this.config === null) return;

        const win = this.config.getWindow();

        try {
            // ── Command Center forwarding ────────────────────────────────
            if (win !== null && !win.isDestroyed()) {
                // Send activity event
                const activityEvent = this.toActivityEvent(event);
                win.webContents.send('command-center:activity-event', activityEvent);

                // Send agent status update if relevant
                if (AGENT_STATUS_CHANNELS.has(event.channel)) {
                    win.webContents.send('command-center:agent-update', {
                        agent: event.agent,
                        channel: event.channel,
                        taskId: event.taskId,
                        data: event.data,
                    });
                }

                // Send project status update if relevant
                if (PROJECT_STATUS_CHANNELS.has(event.channel) && event.projectId !== undefined) {
                    win.webContents.send('command-center:project-update', {
                        projectId: event.projectId,
                        channel: event.channel,
                    });
                }

                // Send approval notification
                if (event.channel === 'approval.required') {
                    win.webContents.send('command-center:approval-needed', {
                        projectId: event.projectId,
                        agent: event.agent,
                        data: event.data,
                    });
                }
            }
        } catch (err) {
            // Never let IPC failures crash the event loop
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err: msg }, 'IPC send failed');
        }
    }

    /**
     * Forward agent.stream events to a dedicated IPC channel (not the general feed).
     */
    private onStreamEvent(event: EventPayload): void {
        if (!this.running || this.config === null) return;
        const win = this.config.getWindow();
        if (win === null || win.isDestroyed()) return;

        try {
            win.webContents.send('command-center:agent-stream-event', {
                time: event.timestamp,
                agent: event.agent,
                taskId: event.taskId,
                projectId: event.projectId,
                data: event.data,
            });
        } catch {
            // Never let IPC failures crash the event loop
        }
    }

    /**
     * Forward intercept acknowledgments to a dedicated IPC channel.
     */
    private onInterceptAck(event: EventPayload): void {
        if (!this.running || this.config === null) return;
        const win = this.config.getWindow();
        if (win === null || win.isDestroyed()) return;

        try {
            win.webContents.send('command-center:intercept-ack', {
                agent: event.agent,
                taskId: event.taskId,
                data: event.data,
            });
        } catch {
            // Never let IPC failures crash the event loop
        }
    }

    private toActivityEvent(event: EventPayload): ActivityEvent {
        return {
            time: event.timestamp,
            agent: event.agent ?? 'system',
            channel: event.channel,
            message: formatEventMessage(event),
            projectId: event.projectId,
            taskId: event.taskId,
            severity: getSeverity(event.channel),
            // Forward the raw payload too — Mission Control's clickable
            // activity row needs full prompt/response/cost data when you
            // expand it, not just the truncated headline.
            data: event.data,
        };
    }
}

// ── Event Formatting ─────────────────────────────────

function formatEventMessage(event: EventPayload): string {
    const data = event.data as Record<string, unknown>;
    const title = typeof data.title === 'string' ? data.title : '';
    const agent = event.agent ?? 'system';

    switch (event.channel) {
        case 'task.created':
            return `New task created: ${title}`;

        case 'task.assigned':
            return `Assigned to ${agent}: ${title}`;

        case 'task.progress': {
            const message = typeof data.message === 'string' ? data.message : 'Working...';
            return `${agent}: ${message}`;
        }

        case 'task.completed': {
            const durationMs = typeof data.durationMs === 'number' ? data.durationMs : 0;
            return `${agent} completed: ${title} (${durationMs}ms)`;
        }

        case 'task.failed': {
            const errorMessage = typeof data.errorMessage === 'string' ? data.errorMessage : 'Unknown error';
            return `${agent} failed: ${title} — ${errorMessage}`;
        }

        case 'task.blocked':
            return `Task blocked: ${title}`;

        case 'review.requested':
            return `Code review requested for task ${event.taskId ?? 'unknown'}`;

        case 'review.passed': {
            const score = typeof data.qualityScore === 'number' ? data.qualityScore : '?';
            return `${agent}: Code review PASSED (quality: ${score}/10)`;
        }

        case 'review.rejected': {
            const score = typeof data.qualityScore === 'number' ? data.qualityScore : '?';
            return `${agent}: Code review REJECTED (quality: ${score}/10)`;
        }

        case 'approval.required': {
            const phase = typeof data.currentPhase === 'string' ? data.currentPhase : 'unknown';
            return `Phase "${phase}" complete — awaiting human approval`;
        }

        case 'approval.granted':
            return `Approval granted — advancing to next phase`;

        case 'approval.denied': {
            const reason = typeof data.reason === 'string' ? data.reason : 'No reason given';
            return `Approval denied: ${reason}`;
        }

        case 'build.started':
            return `Build started: ${title}`;

        case 'build.passed':
            return `Build passed: ${title}`;

        case 'build.failed':
            return `Build FAILED: ${title}`;

        case 'cost.warning': {
            const spent = typeof data.spentUsd === 'number' ? data.spentUsd.toFixed(2) : '?';
            const budget = typeof data.budgetUsd === 'number' ? data.budgetUsd.toFixed(2) : '?';
            return `Budget warning: $${spent} of $${budget} spent (80% threshold)`;
        }

        case 'cost.exceeded': {
            const spent = typeof data.spentUsd === 'number' ? data.spentUsd.toFixed(2) : '?';
            const budget = typeof data.budgetUsd === 'number' ? data.budgetUsd.toFixed(2) : '?';
            return `BUDGET EXCEEDED: $${spent} of $${budget} — tasks will be paused`;
        }

        case 'agent.stream': {
            // Pull a one-line headline out of the AI exchange. The full
            // prompt + response live on event.data and are forwarded to
            // the renderer for click-to-expand display.
            const type = typeof data.type === 'string' ? data.type : 'event';
            if (type === 'ai-exchange') {
                const tokensIn = typeof data.tokensIn === 'number' ? data.tokensIn : null;
                const tokensOut = typeof data.tokensOut === 'number' ? data.tokensOut : null;
                const cost = typeof data.costUsd === 'number' ? data.costUsd : null;
                const meta: string[] = [];
                if (tokensIn !== null && tokensOut !== null) meta.push(`${tokensIn}\u2192${tokensOut} tok`);
                if (cost !== null) meta.push(`$${cost.toFixed(4)}`);
                const tail = meta.length > 0 ? ` (${meta.join(' \u00b7 ')})` : '';
                return `${agent}: AI exchange${tail}`;
            }
            return `${agent}: ${type}`;
        }

        default:
            return `Event: ${event.channel}`;
    }
}

function getSeverity(channel: EventChannel): 'info' | 'warning' | 'error' {
    switch (channel) {
        case 'task.failed':
        case 'build.failed':
        case 'review.rejected':
        case 'cost.exceeded':
            return 'error';

        case 'task.blocked':
        case 'approval.required':
        case 'approval.denied':
        case 'cost.warning':
            return 'warning';

        default:
            return 'info';
    }
}
