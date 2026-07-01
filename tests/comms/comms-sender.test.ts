/**
 * CommsSender behavioral tests
 *
 * Tests queue processing, adapter dispatch, retry logic,
 * and error handling without live database or external services.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock db/client ──────────────────────────────────

const { mockQuery, mockGetMany } = vi.hoisted(() => ({
    mockQuery: vi.fn(async () => ({ rows: [{ id: 'msg-1' }], rowCount: 1 })),
    mockGetMany: vi.fn(async () => []),
}));

vi.mock('../../src/db/client', () => ({
    query: mockQuery,
    getOne: vi.fn(async () => null),
    getMany: mockGetMany,
}));

// ── Mock secret-store ───────────────────────────────

vi.mock('../../src/main/secret-store', () => ({
    getApiKey: vi.fn(async () => null),
    getSecret: vi.fn(async () => null),
}));

// ── Mock adapters ───────────────────────────────────

const { mockTeamsSend, mockEmailSend, mockTeamsConfigured, mockEmailConfigured } = vi.hoisted(() => ({
    mockTeamsSend: vi.fn(async () => undefined),
    mockEmailSend: vi.fn(async () => undefined),
    mockTeamsConfigured: vi.fn(async () => true),
    mockEmailConfigured: vi.fn(async () => true),
}));

vi.mock('../../src/comms/adapters/teams-webhook', () => ({
    TeamsWebhookAdapter: vi.fn(() => ({
        channel: 'teams',
        send: mockTeamsSend,
        isConfigured: mockTeamsConfigured,
    })),
}));

vi.mock('../../src/comms/adapters/smtp-email', () => ({
    SmtpEmailAdapter: vi.fn(() => ({
        channel: 'email',
        send: mockEmailSend,
        isConfigured: mockEmailConfigured,
    })),
}));

// ── Import after mocks ─────────────────────────────

import { CommsSender } from '../../src/comms/comms-sender';

// ── Helpers ─────────────────────────────────────────

function createQueueRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'msg-1',
        project_id: 'proj-1',
        channel: 'teams',
        recipient: null,
        subject: 'Test Subject',
        body: 'Test body content',
        status: 'pending',
        error_message: null,
        retry_count: 0,
        sent_at: null,
        created_at: new Date(),
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────

describe('CommsSender', () => {
    let sender: CommsSender;

    beforeEach(() => {
        vi.clearAllMocks();
        sender = new CommsSender();
    });

    afterEach(() => {
        sender.stop();
    });

    describe('enqueue()', () => {
        it('inserts a pending message into comms_queue', async () => {
            const id = await sender.enqueue({
                channel: 'teams',
                body: 'Hello from KageOps',
                subject: 'Task Complete',
                projectId: 'proj-1',
            });

            expect(id).toBe('msg-1');
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO comms_queue'),
                ['proj-1', 'teams', null, 'Task Complete', 'Hello from KageOps']
            );
        });

        it('handles optional fields (no projectId, no subject)', async () => {
            await sender.enqueue({ channel: 'email', body: 'Message body', recipient: 'user@example.com' });

            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO comms_queue'),
                [null, 'email', 'user@example.com', null, 'Message body']
            );
        });

        // F-355: silently skip when channel adapter is not configured.
        // Pre-fix the unconfigured-channel path inserted a row, then the
        // sender tried 3× retries — 6 ERROR lines per project run for
        // operators who deliberately hadn't wired the channel.
        it('returns a noop sentinel and skips INSERT when channel is unconfigured (F-355)', async () => {
            mockTeamsConfigured.mockResolvedValueOnce(false);
            const id = await sender.enqueue({
                channel: 'teams',
                body: 'Hello',
                projectId: 'proj-1',
            });
            expect(id).toBe('noop-unconfigured-teams');
            expect(mockQuery).not.toHaveBeenCalled();
        });

        it('caches the configured verdict per channel (F-355)', async () => {
            // First call: adapter says yes — INSERT fires
            mockTeamsConfigured.mockResolvedValueOnce(true);
            await sender.enqueue({ channel: 'teams', body: 'msg 1' });
            // Second call: would say no, but cache wins (adapter not consulted)
            mockTeamsConfigured.mockResolvedValueOnce(false);
            await sender.enqueue({ channel: 'teams', body: 'msg 2' });

            expect(mockQuery).toHaveBeenCalledTimes(2);
            expect(mockTeamsConfigured).toHaveBeenCalledTimes(1);
        });

        it('caches the unconfigured verdict per channel (F-355)', async () => {
            mockTeamsConfigured.mockResolvedValueOnce(false);
            await sender.enqueue({ channel: 'teams', body: 'msg 1' });
            // Even if adapter would now say yes, cache wins → still skipped
            mockTeamsConfigured.mockResolvedValueOnce(true);
            const id = await sender.enqueue({ channel: 'teams', body: 'msg 2' });

            expect(id).toBe('noop-unconfigured-teams');
            expect(mockQuery).not.toHaveBeenCalled();
            expect(mockTeamsConfigured).toHaveBeenCalledTimes(1);
        });

        it('treats adapter.isConfigured() throws as unconfigured (F-355)', async () => {
            mockTeamsConfigured.mockRejectedValueOnce(new Error('keychain unavailable'));
            const id = await sender.enqueue({ channel: 'teams', body: 'hi' });
            expect(id).toBe('noop-unconfigured-teams');
            expect(mockQuery).not.toHaveBeenCalled();
        });
    });

    describe('processPending()', () => {
        it('returns 0 when queue is empty', async () => {
            sender.start();
            mockGetMany.mockResolvedValueOnce([]);

            const count = await sender.processPending();

            expect(count).toBe(0);
        });

        it('sends a Teams message and marks it sent', async () => {
            sender.start();
            mockGetMany.mockResolvedValueOnce([createQueueRow()]);

            const count = await sender.processPending();

            expect(count).toBe(1);
            expect(mockTeamsSend).toHaveBeenCalledTimes(1);
            // Check status was set to 'sending', then 'sent'
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("status = 'sending'"),
                ['msg-1']
            );
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("status = 'sent'"),
                ['msg-1']
            );
        });

        it('sends an email message to the correct adapter', async () => {
            sender.start();
            mockGetMany.mockResolvedValueOnce([createQueueRow({ channel: 'email', recipient: 'user@test.com' })]);

            const count = await sender.processPending();

            expect(count).toBe(1);
            expect(mockEmailSend).toHaveBeenCalledTimes(1);
            expect(mockTeamsSend).not.toHaveBeenCalled();
        });

        it('processes multiple messages in order', async () => {
            sender.start();
            mockGetMany.mockResolvedValueOnce([
                createQueueRow({ id: 'msg-1', channel: 'teams' }),
                createQueueRow({ id: 'msg-2', channel: 'email', recipient: 'a@b.com' }),
            ]);

            const count = await sender.processPending();

            expect(count).toBe(2);
            expect(mockTeamsSend).toHaveBeenCalledTimes(1);
            expect(mockEmailSend).toHaveBeenCalledTimes(1);
        });

        it('returns 0 when sender is not running', async () => {
            // Don't call start()
            const count = await sender.processPending();
            expect(count).toBe(0);
        });
    });

    describe('retry logic', () => {
        it('marks message for retry when adapter throws and retryCount < max', async () => {
            sender.start();
            mockGetMany.mockResolvedValueOnce([createQueueRow({ retry_count: 0 })]);
            mockTeamsSend.mockRejectedValueOnce(new Error('Webhook timeout'));

            const count = await sender.processPending();

            expect(count).toBe(0);
            // Should set status back to 'pending' with incremented retry_count
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("status = 'pending'"),
                ['Webhook timeout', 1, 'msg-1']
            );
        });

        it('marks message as failed when retryCount reaches max', async () => {
            sender.start();
            mockGetMany.mockResolvedValueOnce([createQueueRow({ retry_count: 3 })]);
            mockTeamsSend.mockRejectedValueOnce(new Error('Permanent failure'));

            const count = await sender.processPending();

            expect(count).toBe(0);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("status = 'failed'"),
                ['Permanent failure', 3, 'msg-1']
            );
        });

        it('marks message as failed for unknown channel', async () => {
            sender.start();
            mockGetMany.mockResolvedValueOnce([createQueueRow({ channel: 'sms' })]);

            const count = await sender.processPending();

            expect(count).toBe(0);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining("status = 'failed'"),
                [expect.stringContaining('No adapter for channel'), 0, 'msg-1']
            );
        });
    });

    describe('start/stop lifecycle', () => {
        it('start() sets running state', () => {
            sender.start();
            // Second start is a no-op
            sender.start();
            // If it didn't throw, it's idempotent
        });

        it('stop() clears running state', () => {
            sender.start();
            sender.stop();
            // Double stop is safe
            sender.stop();
        });

        it('getChannels() returns configured channels', () => {
            const channels = sender.getChannels();
            expect(channels).toContain('teams');
            expect(channels).toContain('email');
        });
    });

    describe('error handling', () => {
        it('catches database errors during processPending', async () => {
            sender.start();
            mockGetMany.mockRejectedValueOnce(new Error('Connection lost'));

            const count = await sender.processPending();

            expect(count).toBe(0);
        });

        it('continues processing remaining messages when one fails', async () => {
            sender.start();
            mockGetMany.mockResolvedValueOnce([
                createQueueRow({ id: 'msg-1', channel: 'teams' }),
                createQueueRow({ id: 'msg-2', channel: 'teams' }),
            ]);
            // First message fails, second succeeds
            mockTeamsSend
                .mockRejectedValueOnce(new Error('Timeout'))
                .mockResolvedValueOnce(undefined);

            const count = await sender.processPending();

            expect(count).toBe(1);
            expect(mockTeamsSend).toHaveBeenCalledTimes(2);
        });
    });
});
