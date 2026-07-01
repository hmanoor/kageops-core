/**
 * Sensei chat repository — persistent conversation history (PR B of F-302 V1).
 *
 * Sensei used to keep conversation history in-process:
 *   private conversationHistories: Map<string, ChatMessage[]>
 *
 * That broke shared collaboration: two operators on the same project saw
 * two independent threads, neither survived an Electron restart, and no
 * audit / history existed once the process exited.
 *
 * This repository persists user + assistant messages to the
 * `sensei_messages` table created in migration 021. The Sensei consumer
 * uses it transparently for project-scoped channels (channelId starting
 * with `project:<uuid>`); the legacy `'default'` and `'command-center'`
 * channels stay in-memory so non-project chat (setup wizard help etc.)
 * keeps the previous behaviour without paying for a DB write.
 *
 * Repository pattern (per common/coding-style.md): pure data access behind
 * a typed surface so Sensei can be tested with a fake repository, and the
 * SQL stays in one place.
 */

import { getMany, query } from '../db/client';
import { createLogger } from '../shared/logger';

const log = createLogger('SenseiChatRepository');

// ── Types ──────────────────────────────────────────────────────────

/**
 * One message as persisted in `sensei_messages`. Mirrors the table columns
 * one-for-one. The renderer renders these directly — `author_name` +
 * `author_role` drive the attribution UI ("Alice (reviewer): ..."), the
 * created_at timestamp drives the relative-time string.
 */
export interface PersistedSenseiMessage {
    readonly id: string;
    readonly projectId: string | null;
    readonly orgId: string;
    readonly role: 'user' | 'assistant';
    readonly authorUserId: string | null;
    readonly authorName: string;
    readonly authorRole: string | null;
    readonly content: string;
    readonly createdAt: string;
}

/**
 * Subset of fields a caller supplies when persisting a new message —
 * the repository fills in `id`, `created_at`, and applies defaults.
 */
export interface NewSenseiMessage {
    readonly projectId: string | null;
    readonly orgId?: string;
    readonly role: 'user' | 'assistant';
    readonly authorUserId: string | null;
    readonly authorName: string;
    readonly authorRole: string | null;
    readonly content: string;
}

/**
 * Repository contract — what Sensei needs from this module. Tests inject
 * a fake implementation that records calls.
 */
export interface SenseiChatRepository {
    /** Append a new message to the project-scoped log. */
    append(message: NewSenseiMessage): Promise<void>;
    /** Load every message for a project in chronological order. */
    listForProject(projectId: string): Promise<readonly PersistedSenseiMessage[]>;
    /** Delete every message for a project (used when the project is deleted). */
    deleteForProject(projectId: string): Promise<void>;
}

// ── Production implementation ──────────────────────────────────────

/**
 * Channel ID parsing — Sensei's existing channelId is a free-form string.
 * Project-scoped channels are encoded as `project:<uuid>`. Anything else
 * (legacy `'default'`, `'command-center'`) is non-project chat and stays
 * in-memory.
 */
const PROJECT_CHANNEL_PREFIX = 'project:';

/**
 * Returns the project UUID for a project-scoped channel, or null otherwise.
 * Cheap; called on every chat turn so don't grow this past a startsWith check.
 */
export function projectIdFromChannelId(channelId: string): string | null {
    if (!channelId.startsWith(PROJECT_CHANNEL_PREFIX)) return null;
    const rest = channelId.slice(PROJECT_CHANNEL_PREFIX.length);
    return rest === '' ? null : rest;
}

/** Build a project-scoped channel ID. Inverse of `projectIdFromChannelId`. */
export function channelIdForProject(projectId: string): string {
    return `${PROJECT_CHANNEL_PREFIX}${projectId}`;
}

/**
 * Concrete repository backed by the Postgres pool from src/db/client.
 * Errors log and re-throw — Sensei catches at a higher level.
 */
export const senseiChatRepository: SenseiChatRepository = {
    async append(message: NewSenseiMessage): Promise<void> {
        const orgId = message.orgId ?? 'default';
        try {
            await query(
                `INSERT INTO sensei_messages
                    (project_id, org_id, role, author_user_id, author_name, author_role, content)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    message.projectId,
                    orgId,
                    message.role,
                    message.authorUserId,
                    message.authorName,
                    message.authorRole,
                    message.content,
                ],
            );
        } catch (err) {
            log.error(
                { err: err instanceof Error ? err.message : String(err), projectId: message.projectId },
                'Failed to persist sensei message',
            );
            throw err;
        }
    },

    async listForProject(projectId: string): Promise<readonly PersistedSenseiMessage[]> {
        try {
            const rows = await getMany<{
                id: string;
                project_id: string | null;
                org_id: string;
                role: 'user' | 'assistant';
                author_user_id: string | null;
                author_name: string;
                author_role: string | null;
                content: string;
                created_at: string;
            }>(
                `SELECT id, project_id, org_id, role,
                        author_user_id, author_name, author_role,
                        content, created_at
                   FROM sensei_messages
                  WHERE project_id = $1
                  ORDER BY created_at ASC`,
                [projectId],
            );
            return rows.map((r) => ({
                id: r.id,
                projectId: r.project_id,
                orgId: r.org_id,
                role: r.role,
                authorUserId: r.author_user_id,
                authorName: r.author_name,
                authorRole: r.author_role,
                content: r.content,
                createdAt: r.created_at,
            }));
        } catch (err) {
            log.error(
                { err: err instanceof Error ? err.message : String(err), projectId },
                'Failed to load sensei messages',
            );
            return [];
        }
    },

    async deleteForProject(projectId: string): Promise<void> {
        try {
            await query(
                `DELETE FROM sensei_messages WHERE project_id = $1`,
                [projectId],
            );
        } catch (err) {
            log.error(
                { err: err instanceof Error ? err.message : String(err), projectId },
                'Failed to delete sensei messages',
            );
        }
    },
};
