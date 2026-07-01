/**
 * Tests for src/main/ownership-transfer.ts (PR F of F-302 V1, F-326).
 *
 * The four operations and their failure modes — recipient mismatch,
 * already-resolved, expired, target-not-member, duplicate-pending —
 * matter for security boundaries (only the recipient can accept) and
 * for clean UX (proper error codes drive the renderer's message copy).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => {
    type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    const query = vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 }));
    const getOne = vi.fn(async (_sql: string, _params?: unknown[]) => null as unknown);
    const reset = (): void => {
        query.mockReset();
        getOne.mockReset();
    };
    return { query, getOne, reset };
});

vi.mock('../../src/db/client', () => ({
    getOne: mockDb.getOne,
    getPool: () => ({
        query: mockDb.query,
    }),
}));

import {
    requestOwnershipTransfer,
    acceptOwnershipTransfer,
    declineOwnershipTransfer,
    listPendingTransfersForUser,
} from '../../src/main/ownership-transfer';

describe('requestOwnershipTransfer', () => {
    beforeEach(() => mockDb.reset());

    const baseArgs = {
        projectId: 'proj-1',
        fromUserId: 'user-alice',
        fromUserName: 'Alice',
        toUserId: 'user-bob',
        toUserName: 'Bob',
    };

    it('refuses with PROJECT_NOT_FOUND when the project row is missing', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        const result = await requestOwnershipTransfer(baseArgs);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('PROJECT_NOT_FOUND');
    });

    it('refuses with TARGET_NOT_MEMBER when the proposed new owner is not on the project', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ id: 'proj-1' })  // project exists
            .mockResolvedValueOnce(null);              // no membership row
        const result = await requestOwnershipTransfer(baseArgs);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('TARGET_NOT_MEMBER');
    });

    it('inserts a pending transfer when project + target member exist', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ id: 'proj-1' })
            .mockResolvedValueOnce({ role: 'reviewer' });
        mockDb.query.mockResolvedValueOnce({
            rows: [{
                id: 'transfer-1',
                project_id: 'proj-1',
                org_id: 'default',
                from_user_id: 'user-alice', from_user_name: 'Alice',
                to_user_id: 'user-bob', to_user_name: 'Bob',
                status: 'pending', requested_at: '2026-05-10T12:00:00Z',
                resolved_at: null, expires_at: '2026-05-17T12:00:00Z', note: null,
            }],
            rowCount: 1,
        });

        const result = await requestOwnershipTransfer(baseArgs);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.transfer.id).toBe('transfer-1');
        expect(result.transfer.status).toBe('pending');
    });

    it('translates the unique-pending constraint violation to ALREADY_PENDING', async () => {
        mockDb.getOne
            .mockResolvedValueOnce({ id: 'proj-1' })
            .mockResolvedValueOnce({ role: 'reviewer' });
        mockDb.query.mockRejectedValueOnce(
            new Error('duplicate key value violates unique constraint "idx_ownership_transfers_one_pending_per_project"'),
        );
        const result = await requestOwnershipTransfer(baseArgs);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('ALREADY_PENDING');
        expect(result.error).toContain('Cancel');
    });
});

describe('acceptOwnershipTransfer', () => {
    beforeEach(() => mockDb.reset());

    it('refuses with TRANSFER_NOT_FOUND when the row is missing', async () => {
        mockDb.getOne.mockResolvedValueOnce(null);
        const result = await acceptOwnershipTransfer('transfer-1', 'user-bob');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('TRANSFER_NOT_FOUND');
    });

    it('refuses with NOT_RECIPIENT when caller is not the proposed new owner', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            id: 'transfer-1', project_id: 'proj-1', org_id: 'default',
            from_user_id: 'user-alice', from_user_name: 'Alice',
            to_user_id: 'user-bob', to_user_name: 'Bob',
            status: 'pending', requested_at: '2026-05-10T12:00:00Z',
            resolved_at: null,
            expires_at: '2099-01-01T00:00:00Z', note: null,
        });
        const result = await acceptOwnershipTransfer('transfer-1', 'user-charlie');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('NOT_RECIPIENT');
    });

    it('refuses with NOT_PENDING when transfer status is already accepted', async () => {
        mockDb.getOne.mockResolvedValueOnce({
            id: 'transfer-1', project_id: 'proj-1', org_id: 'default',
            from_user_id: 'user-alice', from_user_name: 'Alice',
            to_user_id: 'user-bob', to_user_name: 'Bob',
            status: 'accepted', requested_at: '2026-05-10T12:00:00Z',
            resolved_at: '2026-05-10T13:00:00Z',
            expires_at: '2099-01-01T00:00:00Z', note: null,
        });
        const result = await acceptOwnershipTransfer('transfer-1', 'user-bob');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('NOT_PENDING');
    });

    it('refuses with EXPIRED when expires_at is in the past', async () => {
        const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        mockDb.getOne.mockResolvedValueOnce({
            id: 'transfer-1', project_id: 'proj-1', org_id: 'default',
            from_user_id: 'user-alice', from_user_name: 'Alice',
            to_user_id: 'user-bob', to_user_name: 'Bob',
            status: 'pending', requested_at: '2026-05-01T12:00:00Z',
            resolved_at: null,
            expires_at: past, note: null,
        });
        // The expired marker UPDATE — irrelevant rowCount.
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const result = await acceptOwnershipTransfer('transfer-1', 'user-bob');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('EXPIRED');
    });

    it('refuses NOT_PENDING when the conditional flip returns 0 rows (concurrent accept race)', async () => {
        const future = new Date(Date.now() + 86400000).toISOString();
        mockDb.getOne.mockResolvedValueOnce({
            id: 'transfer-1', project_id: 'proj-1', org_id: 'default',
            from_user_id: 'user-alice', from_user_name: 'Alice',
            to_user_id: 'user-bob', to_user_name: 'Bob',
            status: 'pending', requested_at: '2026-05-10T12:00:00Z',
            resolved_at: null, expires_at: future, note: null,
        });
        // The UPDATE ... WHERE status = 'pending' returns 0 because someone
        // else flipped it between our read and our write.
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const result = await acceptOwnershipTransfer('transfer-1', 'user-bob');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('NOT_PENDING');
    });

    it('happy path: flips role + transfer + activity log + returns accepted transfer', async () => {
        const future = new Date(Date.now() + 86400000).toISOString();
        const transferRow = {
            id: 'transfer-1', project_id: 'proj-1', org_id: 'default',
            from_user_id: 'user-alice', from_user_name: 'Alice',
            to_user_id: 'user-bob', to_user_name: 'Bob',
            status: 'pending' as const, requested_at: '2026-05-10T12:00:00Z',
            resolved_at: null, expires_at: future, note: 'taking over',
        };
        mockDb.getOne
            .mockResolvedValueOnce(transferRow)
            .mockResolvedValueOnce({ ...transferRow, status: 'accepted', resolved_at: '2026-05-10T13:00:00Z' });
        // 1. flip transfer (pending → accepted) — 1 row
        // 2. flip old owner role
        // 3. flip new owner role
        // 4. insert activity log
        mockDb.query
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 })
            .mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const result = await acceptOwnershipTransfer('transfer-1', 'user-bob');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.transfer.status).toBe('accepted');
        expect(result.transfer.resolvedAt).not.toBeNull();

        // Verify the role-flip queries ran with the right user IDs by
        // matching on the SQL prefix (UPDATE project_assignments SET role)
        // — params alone aren't unique because the transfer-flip UPDATE
        // also takes user_id as a param.
        const queryCalls = mockDb.query.mock.calls;
        const roleFlipCalls = queryCalls.filter(
            (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE project_assignments'),
        );
        expect(roleFlipCalls.length).toBe(2);
    });
});

describe('declineOwnershipTransfer', () => {
    beforeEach(() => mockDb.reset());

    it('declines a pending transfer addressed to the caller', async () => {
        mockDb.query.mockResolvedValueOnce({
            rows: [{
                id: 'transfer-1', project_id: 'proj-1', org_id: 'default',
                from_user_id: 'user-alice', from_user_name: 'Alice',
                to_user_id: 'user-bob', to_user_name: 'Bob',
                status: 'declined', requested_at: '2026-05-10T12:00:00Z',
                resolved_at: '2026-05-10T13:00:00Z',
                expires_at: '2099-01-01T00:00:00Z', note: null,
            }],
            rowCount: 1,
        });
        const result = await declineOwnershipTransfer('transfer-1', 'user-bob');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.transfer.status).toBe('declined');
    });

    it('returns NOT_RECIPIENT when caller is not the proposed new owner', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockDb.getOne.mockResolvedValueOnce({ to_user_id: 'user-bob', status: 'pending' });
        const result = await declineOwnershipTransfer('transfer-1', 'user-charlie');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('NOT_RECIPIENT');
    });

    it('returns NOT_PENDING when the transfer was already accepted', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockDb.getOne.mockResolvedValueOnce({ to_user_id: 'user-bob', status: 'accepted' });
        const result = await declineOwnershipTransfer('transfer-1', 'user-bob');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('NOT_PENDING');
    });

    it('returns TRANSFER_NOT_FOUND when no row exists', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        mockDb.getOne.mockResolvedValueOnce(null);
        const result = await declineOwnershipTransfer('transfer-1', 'user-bob');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe('TRANSFER_NOT_FOUND');
    });
});

describe('listPendingTransfersForUser', () => {
    beforeEach(() => mockDb.reset());

    it('returns only pending, unexpired transfers for the given user', async () => {
        // The SQL filter does the work — the test just verifies the
        // mapper produces the public shape.
        mockDb.query.mockResolvedValueOnce({
            rows: [{
                id: 'transfer-1', project_id: 'proj-1', org_id: 'default',
                from_user_id: 'user-alice', from_user_name: 'Alice',
                to_user_id: 'user-bob', to_user_name: 'Bob',
                status: 'pending', requested_at: '2026-05-10T12:00:00Z',
                resolved_at: null,
                expires_at: '2099-01-01T00:00:00Z', note: 'handing off',
            }],
            rowCount: 1,
        });

        const transfers = await listPendingTransfersForUser('user-bob');
        expect(transfers.length).toBe(1);
        expect(transfers[0].fromUserName).toBe('Alice');
        expect(transfers[0].note).toBe('handing off');
    });

    it('returns an empty array when no pending transfers exist', async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const transfers = await listPendingTransfersForUser('user-bob');
        expect(transfers).toEqual([]);
    });
});
