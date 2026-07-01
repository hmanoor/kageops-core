/**
 * Optimistic locking helper (PR C of F-302 V1).
 *
 * Two team members on the same project clicking "Claim task" / "Reopen" /
 * "Approve gate" simultaneously used to race silently — second action
 * overwrites first, no warning. This module gives every mutating IPC
 * handler a consistent way to refuse stale-version writes.
 *
 * Pattern:
 *   1. Renderer reads the current `updated_at` when rendering the row.
 *   2. Renderer passes `expectedUpdatedAt` on the next mutation IPC.
 *   3. Handler calls `checkOptimisticLock(table, id, expected)`. If the
 *      live row's updated_at differs, returns a Conflict result with the
 *      fresh row attached so the renderer can show "Alice just did X".
 *   4. If it matches (or expected was null), handler proceeds.
 *
 * `expectedUpdatedAt === null` means the renderer doesn't have a version
 * to compare against (e.g. it's a brand-new mutation triggered by a slash
 * command). The handler proceeds without locking — back-compat for any
 * call site that hasn't been migrated to pass the timestamp yet.
 */

import { getOne } from '../db/client';

// ── Types ────────────────────────────────────────────────────────────

export type LockResult<TRow> =
    | { readonly ok: true;  readonly currentRow: TRow | null }
    | { readonly ok: false; readonly conflict: true; readonly currentRow: TRow | null; readonly currentUpdatedAt: string | null };

/**
 * Allow-list of tables this helper knows how to query. Hard-coded rather
 * than dynamic so a typo in a handler can't suddenly read from an
 * unrelated table — and the column name is consistently `updated_at`
 * across every entry.
 */
export type LockableTable = 'projects' | 'tasks';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Compare two ISO timestamps for equality, tolerating millisecond /
 * timezone-format differences. Postgres returns timestamps with `+00`
 * offsets; the renderer's display string may use `Z` — both are the same
 * instant. We compare numeric epochs so subtle string differences don't
 * trigger false-conflict toasts.
 */
function timestampsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
    return ta === tb;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Verify the live `updated_at` for a row matches the version the caller
 * thinks they're acting on. Pass `expectedUpdatedAt = null` to skip the
 * check entirely (back-compat path for un-migrated callers).
 *
 * Returns `{ ok: true }` when:
 *   - the caller didn't supply a version (null/undefined), OR
 *   - the live updated_at matches the expected value.
 *
 * Returns `{ ok: false, conflict: true, currentRow, currentUpdatedAt }`
 * when the values differ. The handler should propagate `currentRow` to
 * the renderer so it can refresh the UI with truth and show a conflict
 * toast.
 *
 * The fresh row is selected only when conflict is detected — happy-path
 * lookups stay at one query (the existence + version check).
 */
export async function checkOptimisticLock<TRow extends Record<string, unknown>>(
    table: LockableTable,
    id: string,
    expectedUpdatedAt: string | null | undefined,
): Promise<LockResult<TRow>> {
    if (expectedUpdatedAt === null || expectedUpdatedAt === undefined) {
        // Caller didn't provide a version — skip the check, treat as ok.
        // Production callers SHOULD migrate to pass it; this branch keeps
        // older renderer code working until they do.
        return { ok: true, currentRow: null };
    }

    const row = await getOne<{ updated_at: string }>(
        `SELECT updated_at FROM ${table} WHERE id = $1`,
        [id],
    );

    if (row === null) {
        // The row vanished (e.g. deleted by a concurrent action). Surface
        // as a conflict — the renderer should refresh and the row will be
        // gone from its list.
        return { ok: false, conflict: true, currentRow: null, currentUpdatedAt: null };
    }

    if (timestampsEqual(row.updated_at, expectedUpdatedAt)) {
        return { ok: true, currentRow: null };
    }

    // Conflict — fetch the full row so the renderer can show truth.
    const fresh = await getOne<TRow>(
        `SELECT * FROM ${table} WHERE id = $1`,
        [id],
    );
    return {
        ok: false,
        conflict: true,
        currentRow: fresh,
        currentUpdatedAt: row.updated_at,
    };
}

/**
 * Render a uniform "conflict" envelope for IPC responses. Handlers
 * compose this with their normal response shape via `{ ...envelope }`.
 */
export function conflictResponse(currentUpdatedAt: string | null): {
    readonly success: false;
    readonly conflict: true;
    readonly error: string;
    readonly currentUpdatedAt: string | null;
} {
    return {
        success: false,
        conflict: true,
        error:
            'Someone else updated this just now. ' +
            'Refresh to see their change, then try again.',
        currentUpdatedAt,
    };
}
