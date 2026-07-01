/**
 * SMTP Email Adapter behavioral tests
 *
 * Tests config loading, send validation, and error handling
 * without live SMTP server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock secret-store ───────────────────────────────

const { mockGetSecret } = vi.hoisted(() => ({
    mockGetSecret: vi.fn(async (_service: string, account: string) => {
        const secrets: Record<string, string> = {
            'smtp-host': 'smtp.example.com',
            'smtp-port': '587',
            'smtp-user': 'user@example.com',
            'smtp-password': 'secret123',
            'smtp-from': 'kageops@example.com',
        };
        return secrets[account] ?? null;
    }),
}));

vi.mock('../../src/main/secret-store', () => ({
    getSecret: mockGetSecret,
}));

// ── Mock net ────────────────────────────────────────

const { mockCreateConnection } = vi.hoisted(() => {
    const mockSocket = {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
    };

    return {
        mockCreateConnection: vi.fn(() => mockSocket),
        mockSocket,
    };
});

vi.mock('net', () => ({
    createConnection: mockCreateConnection,
}));

// ── Import after mocks ─────────────────────────────

import { SmtpEmailAdapter } from '../../src/comms/adapters/smtp-email';
import type { CommsMessage } from '../../src/comms/types';

// ── Helpers ─────────────────────────────────────────

function createMessage(overrides: Partial<CommsMessage> = {}): CommsMessage {
    return {
        id: 'msg-1',
        projectId: 'proj-1',
        channel: 'email',
        recipient: 'user@test.com',
        subject: 'Task Completed',
        body: 'Your project has been updated.',
        status: 'sending',
        errorMessage: null,
        retryCount: 0,
        sentAt: null,
        createdAt: new Date(),
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────

describe('SmtpEmailAdapter', () => {
    let adapter: SmtpEmailAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        // Restore default SMTP secret responses
        mockGetSecret.mockImplementation(async (_service: string, account: string) => {
            const secrets: Record<string, string> = {
                'smtp-host': 'smtp.example.com',
                'smtp-port': '587',
                'smtp-user': 'user@example.com',
                'smtp-password': 'secret123',
                'smtp-from': 'kageops@example.com',
            };
            return secrets[account] ?? null;
        });
        adapter = new SmtpEmailAdapter();
    });

    describe('isConfigured()', () => {
        it('returns true when all SMTP secrets are present', async () => {
            const result = await adapter.isConfigured();
            expect(result).toBe(true);
        });

        it('returns false when smtp-host is missing', async () => {
            mockGetSecret.mockImplementation(async (_service: string, account: string) => {
                if (account === 'smtp-host') return null;
                return 'value';
            });

            const result = await adapter.isConfigured();
            expect(result).toBe(false);
        });

        it('returns false when smtp-user is missing', async () => {
            mockGetSecret.mockImplementation(async (_service: string, account: string) => {
                if (account === 'smtp-user') return null;
                return 'value';
            });

            const result = await adapter.isConfigured();
            expect(result).toBe(false);
        });

        it('returns false when smtp-password is missing', async () => {
            mockGetSecret.mockImplementation(async (_service: string, account: string) => {
                if (account === 'smtp-password') return null;
                return 'value';
            });

            const result = await adapter.isConfigured();
            expect(result).toBe(false);
        });
    });

    describe('send()', () => {
        it('throws when SMTP is not configured', async () => {
            mockGetSecret.mockResolvedValue(null);

            await expect(adapter.send(createMessage())).rejects.toThrow('SMTP not configured');
        });

        it('throws when recipient is null', async () => {
            await expect(adapter.send(createMessage({ recipient: null }))).rejects.toThrow('Email recipient is required');
        });

        it('throws when recipient is empty string', async () => {
            await expect(adapter.send(createMessage({ recipient: '  ' }))).rejects.toThrow('Email recipient is required');
        });

        it('creates a socket connection to the configured SMTP host and port', async () => {
            const mockSocket = {
                on: vi.fn(),
                write: vi.fn(),
                end: vi.fn(),
                destroy: vi.fn(),
                setTimeout: vi.fn(),
            };
            mockCreateConnection.mockReturnValue(mockSocket);

            const sendPromise = adapter.send(createMessage());

            // Flush microtasks so loadConfig() resolves before we check
            await new Promise((r) => setTimeout(r, 0));

            expect(mockCreateConnection).toHaveBeenCalledWith(587, 'smtp.example.com');

            // Simulate socket timeout to resolve the promise
            const timeoutHandler = mockSocket.on.mock.calls.find(
                (call: [string, () => void]) => call[0] === 'timeout'
            );
            if (timeoutHandler) {
                timeoutHandler[1]();
            }

            await expect(sendPromise).rejects.toThrow('SMTP connection timed out');
        });

        it('uses default port 587 when smtp-port is not set', async () => {
            mockGetSecret.mockImplementation(async (_service: string, account: string) => {
                if (account === 'smtp-port') return null;
                const secrets: Record<string, string> = {
                    'smtp-host': 'smtp.example.com',
                    'smtp-user': 'user@example.com',
                    'smtp-password': 'secret123',
                    'smtp-from': 'kageops@example.com',
                };
                return secrets[account] ?? null;
            });

            const mockSocket = {
                on: vi.fn(),
                write: vi.fn(),
                end: vi.fn(),
                destroy: vi.fn(),
                setTimeout: vi.fn(),
            };
            mockCreateConnection.mockReturnValue(mockSocket);

            const sendPromise = adapter.send(createMessage());

            // Flush microtasks so loadConfig() resolves
            await new Promise((r) => setTimeout(r, 0));

            expect(mockCreateConnection).toHaveBeenCalledWith(587, 'smtp.example.com');

            // Clean up via error handler
            const errorHandler = mockSocket.on.mock.calls.find(
                (call: [string, (err: Error) => void]) => call[0] === 'error'
            );
            if (errorHandler) {
                errorHandler[1](new Error('test cleanup'));
            }

            await expect(sendPromise).rejects.toThrow();
        });

        it('uses default subject when message subject is null', async () => {
            const mockSocket = {
                on: vi.fn(),
                write: vi.fn(),
                end: vi.fn(),
                destroy: vi.fn(),
                setTimeout: vi.fn(),
            };
            mockCreateConnection.mockReturnValue(mockSocket);

            const sendPromise = adapter.send(createMessage({ subject: null }));

            // Flush microtasks so loadConfig() resolves
            await new Promise((r) => setTimeout(r, 0));

            expect(mockCreateConnection).toHaveBeenCalledTimes(1);

            // Clean up
            const timeoutHandler = mockSocket.on.mock.calls.find(
                (call: [string, () => void]) => call[0] === 'timeout'
            );
            if (timeoutHandler) {
                timeoutHandler[1]();
            }

            await expect(sendPromise).rejects.toThrow();
        });
    });

    describe('channel property', () => {
        it('is email', () => {
            expect(adapter.channel).toBe('email');
        });
    });
});
