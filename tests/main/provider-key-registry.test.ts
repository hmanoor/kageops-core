/**
 * Provider Key Registry unit tests
 *
 * Tests CRUD operations for the multi-key provider registry.
 * Mocks DB client and secret-store to test logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB client ─────────────────────────────────

const mockQuery = vi.fn();
const mockGetOne = vi.fn();
const mockGetMany = vi.fn();

vi.mock('../../src/db/client', () => ({
    query: (...args: unknown[]) => mockQuery(...args),
    getOne: (...args: unknown[]) => mockGetOne(...args),
    getMany: (...args: unknown[]) => mockGetMany(...args),
}));

// ── Mock secret-store ──────────────────────────────

const mockGetSecret = vi.fn();
const mockSetSecret = vi.fn();
const mockDeleteSecret = vi.fn();

vi.mock('../../src/main/secret-store', () => ({
    getSecret: (...args: unknown[]) => mockGetSecret(...args),
    setSecret: (...args: unknown[]) => mockSetSecret(...args),
    deleteSecret: (...args: unknown[]) => mockDeleteSecret(...args),
}));

// ── Mock logger ────────────────────────────────────

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

// ── Tests ──��───────────────────────────────────────

describe('ProviderKeyRegistry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('addProviderKey()', () => {
        it('inserts metadata and stores key in keychain', async () => {
            const keyId = 'abc-123';
            mockGetOne.mockResolvedValueOnce({ id: keyId, created_at: '2026-01-01', updated_at: '2026-01-01' });
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
            mockSetSecret.mockResolvedValue(undefined);

            const { addProviderKey } = await import('../../src/main/provider-key-registry');
            const result = await addProviderKey({
                provider: 'claude',
                label: 'work',
                apiKey: 'sk-ant-xxx',
                isDefault: false,
            });

            expect(result.id).toBe(keyId);
            expect(result.provider).toBe('claude');
            expect(result.label).toBe('work');
            expect(result.hasKey).toBe(true);
            expect(mockSetSecret).toHaveBeenCalledWith('kageops', `provider-key-claude-${keyId}`, 'sk-ant-xxx');
        });

        it('unsets existing default when adding a new default', async () => {
            const keyId = 'def-456';
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
            mockGetOne.mockResolvedValueOnce({ id: keyId, created_at: '2026-01-01', updated_at: '2026-01-01' });
            mockSetSecret.mockResolvedValue(undefined);

            const { addProviderKey } = await import('../../src/main/provider-key-registry');
            await addProviderKey({
                provider: 'openai',
                label: 'primary',
                apiKey: 'sk-openai-xxx',
                isDefault: true,
            });

            // Should have called query to unset existing defaults
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('SET is_default = false'),
                expect.arrayContaining(['openai'])
            );
        });

        it('throws on empty provider', async () => {
            const { addProviderKey } = await import('../../src/main/provider-key-registry');
            await expect(addProviderKey({
                provider: '',
                label: 'test',
                apiKey: 'xxx',
            })).rejects.toThrow('Provider is required');
        });

        it('throws on empty label', async () => {
            const { addProviderKey } = await import('../../src/main/provider-key-registry');
            await expect(addProviderKey({
                provider: 'claude',
                label: '',
                apiKey: 'xxx',
            })).rejects.toThrow('Label is required');
        });

        it('throws on empty API key', async () => {
            const { addProviderKey } = await import('../../src/main/provider-key-registry');
            await expect(addProviderKey({
                provider: 'claude',
                label: 'test',
                apiKey: '  ',
            })).rejects.toThrow('API key is required');
        });
    });

    describe('listProviderKeys()', () => {
        it('returns all keys when no filter given', async () => {
            mockGetMany.mockResolvedValueOnce([
                { id: '1', provider: 'claude', label: 'work', keychain_account: 'provider-key-claude-1', project_id: null, is_default: true, created_at: '2026-01-01' },
                { id: '2', provider: 'openai', label: 'personal', keychain_account: 'provider-key-openai-2', project_id: null, is_default: false, created_at: '2026-01-02' },
            ]);
            mockGetSecret.mockResolvedValue('some-secret');

            const { listProviderKeys } = await import('../../src/main/provider-key-registry');
            const keys = await listProviderKeys();

            expect(keys).toHaveLength(2);
            expect(keys[0].provider).toBe('claude');
            expect(keys[0].hasKey).toBe(true);
            expect(keys[1].provider).toBe('openai');
        });

        it('filters by provider', async () => {
            mockGetMany.mockResolvedValueOnce([
                { id: '1', provider: 'claude', label: 'work', keychain_account: 'x', project_id: null, is_default: true, created_at: '2026-01-01' },
            ]);
            mockGetSecret.mockResolvedValue('key');

            const { listProviderKeys } = await import('../../src/main/provider-key-registry');
            const keys = await listProviderKeys('claude');

            expect(keys).toHaveLength(1);
            expect(mockGetMany).toHaveBeenCalledWith(
                expect.stringContaining('provider = $1'),
                ['claude']
            );
        });

        it('returns hasKey: false when keychain returns null', async () => {
            mockGetMany.mockResolvedValueOnce([
                { id: '1', provider: 'claude', label: 'expired', keychain_account: 'x', project_id: null, is_default: false, created_at: '2026-01-01' },
            ]);
            mockGetSecret.mockResolvedValue(null);

            const { listProviderKeys } = await import('../../src/main/provider-key-registry');
            const keys = await listProviderKeys();

            expect(keys[0].hasKey).toBe(false);
        });
    });

    describe('resolveDefaultKey()', () => {
        it('returns project-scoped default first', async () => {
            mockGetOne.mockResolvedValueOnce({ keychain_account: 'proj-key' });
            mockGetSecret.mockResolvedValueOnce('project-secret');

            const { resolveDefaultKey } = await import('../../src/main/provider-key-registry');
            const key = await resolveDefaultKey('claude', 'proj-123');

            expect(key).toBe('project-secret');
        });

        it('falls back to global default', async () => {
            // Project-scoped query returns null
            mockGetOne.mockResolvedValueOnce(null);
            // Global query returns a key
            mockGetOne.mockResolvedValueOnce({ keychain_account: 'global-key' });
            mockGetSecret.mockResolvedValueOnce('global-secret');

            const { resolveDefaultKey } = await import('../../src/main/provider-key-registry');
            const key = await resolveDefaultKey('claude', 'proj-123');

            expect(key).toBe('global-secret');
        });

        it('returns null when no default exists', async () => {
            mockGetOne.mockResolvedValue(null);

            const { resolveDefaultKey } = await import('../../src/main/provider-key-registry');
            const key = await resolveDefaultKey('claude');

            expect(key).toBeNull();
        });
    });

    describe('deleteProviderKey()', () => {
        it('removes from both DB and keychain', async () => {
            mockGetOne.mockResolvedValueOnce({ keychain_account: 'provider-key-claude-abc' });
            mockDeleteSecret.mockResolvedValue(undefined);
            mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

            const { deleteProviderKey } = await import('../../src/main/provider-key-registry');
            const result = await deleteProviderKey('abc');

            expect(result.success).toBe(true);
            expect(mockDeleteSecret).toHaveBeenCalledWith('kageops', 'provider-key-claude-abc');
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM provider_keys'),
                ['abc']
            );
        });

        it('returns error for non-existent key', async () => {
            mockGetOne.mockResolvedValueOnce(null);

            const { deleteProviderKey } = await import('../../src/main/provider-key-registry');
            const result = await deleteProviderKey('nonexistent');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Key not found');
        });
    });

    describe('updateProviderKey()', () => {
        it('updates label in DB', async () => {
            mockGetOne.mockResolvedValueOnce({ provider: 'claude', keychain_account: 'x' });
            mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

            const { updateProviderKey } = await import('../../src/main/provider-key-registry');
            const result = await updateProviderKey('key-1', { label: 'new-name' });

            expect(result.success).toBe(true);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('label = $1'),
                expect.arrayContaining(['new-name', 'key-1'])
            );
        });

        it('updates keychain when apiKey provided', async () => {
            mockGetOne.mockResolvedValueOnce({ provider: 'claude', keychain_account: 'existing-account' });
            mockSetSecret.mockResolvedValue(undefined);
            mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

            const { updateProviderKey } = await import('../../src/main/provider-key-registry');
            const result = await updateProviderKey('key-1', { apiKey: 'new-secret' });

            expect(result.success).toBe(true);
            expect(mockSetSecret).toHaveBeenCalledWith('kageops', 'existing-account', 'new-secret');
        });

        it('returns error for non-existent key', async () => {
            mockGetOne.mockResolvedValueOnce(null);

            const { updateProviderKey } = await import('../../src/main/provider-key-registry');
            const result = await updateProviderKey('bad-id', { label: 'x' });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Key not found');
        });
    });

    describe('resolveKeySecret()', () => {
        it('returns the actual key from keychain', async () => {
            mockGetOne.mockResolvedValueOnce({ keychain_account: 'provider-key-claude-1' });
            mockGetSecret.mockResolvedValueOnce('sk-ant-real-key');

            const { resolveKeySecret } = await import('../../src/main/provider-key-registry');
            const key = await resolveKeySecret('1');

            expect(key).toBe('sk-ant-real-key');
            expect(mockGetSecret).toHaveBeenCalledWith('kageops', 'provider-key-claude-1');
        });

        it('returns null when key record not found', async () => {
            mockGetOne.mockResolvedValueOnce(null);

            const { resolveKeySecret } = await import('../../src/main/provider-key-registry');
            const key = await resolveKeySecret('nonexistent');

            expect(key).toBeNull();
        });
    });
});
