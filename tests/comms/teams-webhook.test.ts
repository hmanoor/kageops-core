/**
 * Teams Webhook Adapter behavioral tests
 *
 * Tests Adaptive Card building, HTTP posting, and error handling
 * without live Teams webhook endpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock secret-store ───────────────────────────────

const { mockGetSecret } = vi.hoisted(() => ({
    mockGetSecret: vi.fn(async (_service: string, _account: string) => 'https://outlook.office.com/webhook/test-url'),
}));

vi.mock('../../src/main/secret-store', () => ({
    getSecret: mockGetSecret,
}));

// ── Mock fetch ──────────────────────────────────────

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '1',
    })),
}));

vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks ─────────────────────────────

import { TeamsWebhookAdapter } from '../../src/comms/adapters/teams-webhook';
import type { CommsMessage } from '../../src/comms/types';

// ── Helpers ─────────────────────────────────────────

function createMessage(overrides: Partial<CommsMessage> = {}): CommsMessage {
    return {
        id: 'msg-1',
        projectId: 'proj-1',
        channel: 'teams',
        recipient: null,
        subject: 'Task Completed',
        body: 'Blueprint finished the architecture document.',
        status: 'sending',
        errorMessage: null,
        retryCount: 0,
        sentAt: null,
        createdAt: new Date(),
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────

describe('TeamsWebhookAdapter', () => {
    let adapter: TeamsWebhookAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = new TeamsWebhookAdapter();
    });

    describe('send()', () => {
        it('posts an Adaptive Card to the webhook URL', async () => {
            await adapter.send(createMessage());

            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe('https://outlook.office.com/webhook/test-url');
            expect(options.method).toBe('POST');
            expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
        });

        it('includes subject as title in Adaptive Card', async () => {
            await adapter.send(createMessage({ subject: 'Phase Gate Approved' }));

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            const cardContent = body.attachments[0].content;
            const titleBlock = cardContent.body.find((b: Record<string, unknown>) => b.weight === 'Bolder');
            expect(titleBlock.text).toBe('Phase Gate Approved');
        });

        it('includes message body in Adaptive Card', async () => {
            await adapter.send(createMessage({ body: 'All tasks completed.' }));

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            const cardContent = body.attachments[0].content;
            const textBlock = cardContent.body.find((b: Record<string, unknown>) => b.wrap === true);
            expect(textBlock.text).toBe('All tasks completed.');
        });

        it('includes projectId in FactSet when present', async () => {
            await adapter.send(createMessage({ projectId: 'proj-abc' }));

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            const cardContent = body.attachments[0].content;
            const factSet = cardContent.body.find((b: Record<string, unknown>) => b.type === 'FactSet');
            expect(factSet).toBeDefined();
            expect(factSet.facts[0].value).toBe('proj-abc');
        });

        it('omits FactSet when projectId is null', async () => {
            await adapter.send(createMessage({ projectId: null }));

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            const cardContent = body.attachments[0].content;
            const factSet = cardContent.body.find((b: Record<string, unknown>) => b.type === 'FactSet');
            expect(factSet).toBeUndefined();
        });

        it('omits title block when subject is null', async () => {
            await adapter.send(createMessage({ subject: null }));

            const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            const body = JSON.parse(options.body as string);
            const cardContent = body.attachments[0].content;
            const titleBlock = cardContent.body.find((b: Record<string, unknown>) => b.weight === 'Bolder');
            expect(titleBlock).toBeUndefined();
        });

        it('throws when webhook URL is not configured', async () => {
            mockGetSecret.mockResolvedValueOnce(null);

            await expect(adapter.send(createMessage())).rejects.toThrow('Teams webhook URL not configured');
        });

        it('throws when webhook returns non-OK status', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 429,
                text: async () => 'Too Many Requests',
            });

            await expect(adapter.send(createMessage())).rejects.toThrow('Teams webhook returned 429');
        });
    });

    describe('isConfigured()', () => {
        it('returns true when webhook URL starts with https://', async () => {
            const result = await adapter.isConfigured();
            expect(result).toBe(true);
        });

        it('returns false when webhook URL is null', async () => {
            mockGetSecret.mockResolvedValueOnce(null);

            const result = await adapter.isConfigured();
            expect(result).toBe(false);
        });

        it('returns false when webhook URL does not start with https://', async () => {
            mockGetSecret.mockResolvedValueOnce('http://insecure-url');

            const result = await adapter.isConfigured();
            expect(result).toBe(false);
        });
    });

    describe('channel property', () => {
        it('is teams', () => {
            expect(adapter.channel).toBe('teams');
        });
    });
});
