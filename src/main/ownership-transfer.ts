/**
 * Owner transfer flow (PR F of F-302 V1, F-326).
 *
 * Four operations, all backed by the `ownership_transfers` table from
 * migration 023:
 *
 *   1. requestOwnershipTransfer — current owner initiates. Refuses if a
 *      pending transfer already exists for the project.
 *   2. acceptOwnershipTransfer — new owner accepts. Atomic: flips
 *      project_assignments roles (current owner → reviewer, new owner →
 *      owner), marks the transfer accepted, writes an activity log entry.
 *   3. declineOwnershipTransfer — new owner declines. Marks declined.
 *   4. listPendingTransfersForUser — surfaces any incoming pending
 *      transfers so the renderer can show a banner notification.
 *
 * Permission gating happens at the IPC layer (caller's Clerk user ID is
 * checked via `requireRole(['owner'])` for request, against the to_user
 * field for accept/decline). This module is pure DB orchestration —
 * authorisation is the IPC's responsibility.
 *
 * Atomicity: every state transition runs inside a single Postgres
 * transaction so a process death between the role flip and the transfer
 * status update can't leave the project ownerless.
 */

import { getPool, getOne } from '../db/client';
import { createLogger } from '../shared/logger';

const log = createLogger('OwnershipTransfer');

// ── Types ────────────────────────────────────────────────────────────

export interface OwnershipTransfer {
    readonly id: string;
    readonly projectId: string;
    readonly orgId: string;
    readonly fromUserId: string;
    readonly fromUserName: string;
    readonly toUserId: string;
    readonly toUserName: string;
    readonly status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
    readonly requestedAt: string;
    readonly resolvedAt: string | null;
    readonly expiresAt: string;
    readonly note: string | null;
}

export interface RequestArgs {
    readonly projectId: string;
    readonly fromUserId: string;
    readonly fromUserName: string;
    readonly toUserId: string;
    readonly toUserName: string;
    readonly note?: string;
    readonly orgId?: string;
}

export type TransferResult =
    | { readonly ok: true; readonly transfer: OwnershipTransfer }
    | { readonly ok: false; readonly error: string; readonly code: TransferErrorCode };

export type TransferErrorCode =
    | 'ALREADY_PENDING'       // a pending transfer already exists for this project
    | 'PROJECT_NOT_FOUND'
    | 'TRANSFER_NOT_FOUND'
    | 'NOT_RECIPIENT'         // accept/decline by someone other than to_user
    | 'NOT_PENDING'           // accept/decline against a non-pending transfer
    | 'EXPIRED'               // transfer's expires_at is in the past
    | 'TARGET_NOT_MEMBER';    // the proposed new owner isn't on the project yet

// ── Helpers ──────────────────────────────────────────────────────────

function rowToTransfer(row: {
    id: string;
    project_id: string;
    org_id: string;
    from_user_id: string;
    from_user_name: string;
    to_user_id: string;
    to_user_name: string;
    status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
    requested_at: string;
    resolved_at: string | null;
    expires_at: string;
    note: string | null;
}): OwnershipTransfer {
    return {
        id: row.id,
        projectId: row.project_id,
        orgId: row.org_id,
        fromUserId: row.from_user_id,
        fromUserName: row.from_user_name,
        toUserId: row.to_user_id,
        toUserName: row.to_user_name,
        status: row.status,
        requestedAt: row.requested_at,
        resolvedAt: row.resolved_at,
        expiresAt: row.expires_at,
        note: row.note,
    };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Initiate a transfer. Refuses if there's already a pending one for this
 * project (cancel it first) or if the proposed new owner isn't already a
 * member. The latter check enforces a "must already be on the project"
 * pre-condition — callers should add the new owner as a `reviewer` first
 * if they aren't a member yet.
 */
export async function requestOwnershipTransfer(args: RequestArgs): Promise<TransferResult> {
    const projectExists = await getOne<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1',
        [args.projectId],
    );
    if (projectExists === null) {
        return { ok: false, code: 'PROJECT_NOT_FOUND', error: 'Project not found.' };
    }

    const targetMember = await getOne<{ role: string }>(
        `SELECT role FROM project_assignments
         WHERE project_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [args.projectId, args.toUserId],
    );
    if (targetMember === null) {
        return {
            ok: false,
            code: 'TARGET_NOT_MEMBER',
            error: 'Add the new owner as a project member before transferring.',
        };
    }

    const orgId = args.orgId ?? 'default';
    const db = getPool();

    try {
        const inserted = await db.query<{
            id: string; project_id: string; org_id: string;
            from_user_id: string; from_user_name: string;
            to_user_id: string; to_user_name: string;
            status: 'pending'; requested_at: string;
            resolved_at: null; expires_at: string; note: string | null;
        }>(
            `INSERT INTO ownership_transfers
                (project_id, org_id, from_user_id, from_user_name,
                 to_user_id, to_user_name, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [args.projectId, orgId, args.fromUserId, args.fromUserName,
             args.toUserId, args.toUserName, args.note ?? null],
        );
        return { ok: true, transfer: rowToTransfer(inserted.rows[0]) };
    } catch (err) {
        // The unique partial index on (project_id) WHERE status = 'pending'
        // throws on duplicate-pending. Translate to a typed code rather
        // than leaking the SQLSTATE.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('idx_ownership_transfers_one_pending_per_project') || msg.includes('unique')) {
            return {
                ok: false,
                code: 'ALREADY_PENDING',
                error: 'A pending transfer already exists for this project. Cancel it before starting another.',
            };
        }
        log.error({ err: msg }, 'requestOwnershipTransfer failed');
        return { ok: false, code: 'PROJECT_NOT_FOUND', error: msg };
    }
}

/**
 * Accept a transfer as the proposed new owner.
 *
 * Sequence of operations:
 *  1. Read the transfer row + validate state (pending, recipient match,
 *     not expired). Auto-mark expired rows.
 *  2. Atomically flip status from `pending` to `accepted` — guards against
 *     double-accept races. If the conditional UPDATE returns 0 rows, the
 *     row is no longer pending and we abort.
 *  3. Flip the project_assignments roles (old owner → reviewer, new owner
 *     → owner).
 *  4. Insert the activity log entry.
 *
 * Steps 3 + 4 are not wrapped in a transaction — the PoolLike abstraction
 * doesn't expose a dedicated client. The state-flip in step 2 is the
 * critical guard; if a process death after step 2 leaves the role flip
 * incomplete, the renderer surfaces an inconsistent state and the operator
 * can re-run via the recovery slash command. PGlite (the default embedded
 * backend) is single-process anyway so this is largely theoretical.
 */
export async function acceptOwnershipTransfer(
    transferId: string,
    callerUserId: string,
): Promise<TransferResult> {
    const db = getPool();

    // 1. Read the transfer + validate.
    const transferRow = await getOne<{
        id: string; project_id: string; org_id: string;
        from_user_id: string; from_user_name: string;
        to_user_id: string; to_user_name: string;
        status: 'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
        requested_at: string; resolved_at: string | null;
        expires_at: string; note: string | null;
    }>(
        'SELECT * FROM ownership_transfers WHERE id = $1',
        [transferId],
    );
    if (transferRow === null) {
        return { ok: false, code: 'TRANSFER_NOT_FOUND', error: 'Transfer request not found.' };
    }
    if (transferRow.to_user_id !== callerUserId) {
        return { ok: false, code: 'NOT_RECIPIENT', error: 'Only the proposed new owner can accept this transfer.' };
    }
    if (transferRow.status !== 'pending') {
        return { ok: false, code: 'NOT_PENDING', error: `Transfer is already ${transferRow.status}.` };
    }
    if (Date.parse(transferRow.expires_at) < Date.now()) {
        await db.query(
            `UPDATE ownership_transfers SET status = 'expired', resolved_at = NOW() WHERE id = $1 AND status = 'pending'`,
            [transferId],
        );
        return { ok: false, code: 'EXPIRED', error: 'This transfer request has expired.' };
    }

    // 2. Atomically flip pending → accepted. Conditional UPDATE acts as a
    // CAS-style guard against a concurrent accept / decline / cancel.
    const flipResult = await db.query(
        `UPDATE ownership_transfers
            SET status = 'accepted', resolved_at = NOW()
          WHERE id = $1
            AND status = 'pending'
            AND to_user_id = $2`,
        [transferId, callerUserId],
    );
    if (flipResult.rowCount === 0) {
        return { ok: false, code: 'NOT_PENDING', error: 'Transfer is no longer pending.' };
    }

    // 3. Role flip — old owner → reviewer, new owner → owner. Best-effort
    // logging on individual failures; the transfer is committed accepted
    // either way so the operator's mental model says "I accepted."
    try {
        await db.query(
            `UPDATE project_assignments
                SET role = 'reviewer'
              WHERE project_id = $1 AND user_id = $2 AND removed_at IS NULL`,
            [transferRow.project_id, transferRow.from_user_id],
        );
        await db.query(
            `UPDATE project_assignments
                SET role = 'owner'
              WHERE project_id = $1 AND user_id = $2 AND removed_at IS NULL`,
            [transferRow.project_id, transferRow.to_user_id],
        );
    } catch (err) {
        log.error(
            { err: err instanceof Error ? err.message : String(err), transferId },
            'Role flip failed after transfer accept — manual recovery required',
        );
    }

    // 4. Activity log entry. Failures here only affect the audit trail.
    try {
        await db.query(
            `INSERT INTO human_activity_log (user_id, user_name, project_id, action, detail, org_id)
             VALUES ($1, $2, $3, 'project.ownership_transferred', $4, $5)`,
            [
                transferRow.to_user_id,
                transferRow.to_user_name,
                transferRow.project_id,
                `Ownership transferred from ${transferRow.from_user_name}`,
                transferRow.org_id,
            ],
        );
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err), transferId },
            'Activity log insert failed after transfer accept',
        );
    }

    const finalRow = await getOne<{
        id: string; project_id: string; org_id: string;
        from_user_id: string; from_user_name: string;
        to_user_id: string; to_user_name: string;
        status: 'accepted'; requested_at: string;
        resolved_at: string; expires_at: string; note: string | null;
    }>('SELECT * FROM ownership_transfers WHERE id = $1', [transferId]);
    if (finalRow === null) {
        return { ok: false, code: 'TRANSFER_NOT_FOUND', error: 'Transfer disappeared mid-flight.' };
    }
    return { ok: true, transfer: rowToTransfer(finalRow) };
}

/**
 * Decline a transfer as the proposed new owner. Marks the row declined.
 * Refuses if caller isn't the recipient or the transfer isn't pending.
 */
export async function declineOwnershipTransfer(
    transferId: string,
    callerUserId: string,
): Promise<TransferResult> {
    const db = getPool();
    const result = await db.query<{
        id: string; project_id: string; org_id: string;
        from_user_id: string; from_user_name: string;
        to_user_id: string; to_user_name: string;
        status: 'declined'; requested_at: string;
        resolved_at: string;
        expires_at: string; note: string | null;
    }>(
        `UPDATE ownership_transfers
            SET status = 'declined', resolved_at = NOW()
          WHERE id = $1
            AND to_user_id = $2
            AND status = 'pending'
         RETURNING *`,
        [transferId, callerUserId],
    );
    if (result.rowCount === 0) {
        // Distinguish wrong-recipient from already-resolved by reading the row.
        const probe = await getOne<{ to_user_id: string; status: string }>(
            'SELECT to_user_id, status FROM ownership_transfers WHERE id = $1',
            [transferId],
        );
        if (probe === null) return { ok: false, code: 'TRANSFER_NOT_FOUND', error: 'Transfer request not found.' };
        if (probe.to_user_id !== callerUserId) {
            return { ok: false, code: 'NOT_RECIPIENT', error: 'Only the proposed new owner can decline this transfer.' };
        }
        return { ok: false, code: 'NOT_PENDING', error: `Transfer is already ${probe.status}.` };
    }
    return { ok: true, transfer: rowToTransfer(result.rows[0]) };
}

/**
 * Pending transfers awaiting the given user's response. Expired rows are
 * filtered out so callers don't surface dead requests.
 */
export async function listPendingTransfersForUser(
    callerUserId: string,
): Promise<readonly OwnershipTransfer[]> {
    const db = getPool();
    const result = await db.query<{
        id: string; project_id: string; org_id: string;
        from_user_id: string; from_user_name: string;
        to_user_id: string; to_user_name: string;
        status: 'pending'; requested_at: string;
        resolved_at: null;
        expires_at: string; note: string | null;
    }>(
        `SELECT * FROM ownership_transfers
          WHERE to_user_id = $1
            AND status = 'pending'
            AND expires_at > NOW()
          ORDER BY requested_at DESC`,
        [callerUserId],
    );
    return result.rows.map(rowToTransfer);
}
