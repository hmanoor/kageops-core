/**
 * Tests for src/orchestrator/sensei-chat-repository.ts (PR B of F-302).
 *
 * The repository pattern itself is covered by the production module's
 * pure helpers (`projectIdFromChannelId`, `channelIdForProject`). The
 * Postgres-backed implementation is tested via Sensei's integration path
 * in `sensei-shared-chat.test.ts` so we don't double-test the SQL.
 */

import { describe, it, expect } from 'vitest';
import {
    projectIdFromChannelId,
    channelIdForProject,
} from '../../src/orchestrator/sensei-chat-repository';

describe('projectIdFromChannelId', () => {
    it('extracts the UUID from a project: prefix', () => {
        expect(projectIdFromChannelId('project:7c4f3a2e-1111-4aaa-9bbb-222233334444'))
            .toBe('7c4f3a2e-1111-4aaa-9bbb-222233334444');
    });

    it('returns null for legacy channels', () => {
        expect(projectIdFromChannelId('default')).toBeNull();
        expect(projectIdFromChannelId('command-center')).toBeNull();
    });

    it('returns null for empty UUID after the prefix', () => {
        expect(projectIdFromChannelId('project:')).toBeNull();
    });

    it('preserves the full string after the prefix (uuid validation lives at IPC, not here)', () => {
        // The repository doesn't second-guess the project ID — it trusts
        // the caller (the IPC layer validates UUIDs). This test pins that
        // contract so a future refactor doesn't accidentally start
        // rejecting valid IDs that don't match a hard-coded UUID regex.
        expect(projectIdFromChannelId('project:not-a-uuid-but-trusted'))
            .toBe('not-a-uuid-but-trusted');
    });
});

describe('channelIdForProject', () => {
    it('round-trips through projectIdFromChannelId', () => {
        const id = '7c4f3a2e-1111-4aaa-9bbb-222233334444';
        expect(projectIdFromChannelId(channelIdForProject(id))).toBe(id);
    });
});
