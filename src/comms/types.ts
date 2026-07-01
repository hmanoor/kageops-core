/**
 * KageOps Communication Types
 *
 * Shared types for the communication infrastructure.
 * All comms flow through the comms_queue table in Postgres.
 */

// ── Channel Types ───────────────────────────────────

export type CommsChannel = 'teams' | 'email' | 'slack';

export type CommsStatus = 'pending' | 'sending' | 'sent' | 'failed';

// ── Queue Message ───────────────────────────────────

export interface CommsMessage {
    readonly id: string;
    readonly projectId: string | null;
    readonly channel: CommsChannel;
    readonly recipient: string | null;
    readonly subject: string | null;
    readonly body: string;
    readonly status: CommsStatus;
    readonly errorMessage: string | null;
    readonly retryCount: number;
    readonly sentAt: Date | null;
    readonly createdAt: Date;
}

// ── Channel Adapter Interface ───────────────────────

export interface ChannelAdapter {
    readonly channel: CommsChannel;

    /**
     * Send a message through this channel.
     * Returns true on success, throws on failure.
     */
    send(message: CommsMessage): Promise<void>;

    /**
     * Check if this adapter is configured and ready.
     */
    isConfigured(): Promise<boolean>;
}

// ── Enqueue Options ─────────────────────────────────

export interface EnqueueOptions {
    readonly projectId?: string;
    readonly channel: CommsChannel;
    readonly recipient?: string;
    readonly subject?: string;
    readonly body: string;
}
