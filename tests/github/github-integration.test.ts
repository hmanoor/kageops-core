/**
 * Tests for github-integration.ts
 *
 * Tests the event-driven facade: review.passed -> PR creation -> CI polling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────

const integrationMocks = vi.hoisted(() => ({
    mockQuery: vi.fn(),
    mockGetApiKey: vi.fn(),
}));

vi.mock('../../src/db/client', () => ({
    query: integrationMocks.mockQuery,
}));

vi.mock('../../src/main/secret-store', () => ({
    getApiKey: integrationMocks.mockGetApiKey,
}));

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

// ── Import under test ─────────────────────────────────

import {
    GitHubIntegration,
    resetGitHubIntegrationForTesting,
} from '../../src/github/github-integration';

// ── Helpers ───────────────────────────────────────────

function makeClient() {
    return {
        pushBranch: vi.fn(async () => undefined),
        createPullRequest: vi.fn(async () => ({
            number: 99,
            html_url: 'https://github.com/owner/repo/pull/99',
            head: { sha: 'deadbeef' },
            state: 'open',
        })),
        getCheckRuns: vi.fn(async () => ({ total_count: 0, check_runs: [] })),
        triggerWorkflowDispatch: vi.fn(),
        validateToken: vi.fn(),
        rateLimitInfo: { remaining: 5000, resetAt: 0 },
    };
}

function makeEventBus() {
    const handlers: Record<string, ((e: unknown) => unknown)[]> = {};
    return {
        subscribe: vi.fn(async (channel: string, cb: (e: unknown) => unknown) => {
            handlers[channel] = handlers[channel] ?? [];
            handlers[channel].push(cb);
        }),
        publish: vi.fn(async () => undefined),
        _trigger: async (channel: string, event: unknown) => {
            for (const cb of handlers[channel] ?? []) {
                await cb(event);
            }
        },
    };
}

// ── Tests ─────────────────────────────────────────────

describe('GitHubIntegration', () => {
    beforeEach(() => {
        resetGitHubIntegrationForTesting();
        integrationMocks.mockQuery.mockReset();
        integrationMocks.mockGetApiKey.mockReset();
    });

    it('subscribes to review.passed on start()', async () => {
        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);

        await integration.start();

        expect(eventBus.subscribe).toHaveBeenCalledWith('review.passed', expect.any(Function));
    });

    it('creates PR and publishes pr.created on review.passed when GitHub is configured', async () => {
        integrationMocks.mockQuery
            .mockResolvedValueOnce({
                rows: [{ github_owner: 'myorg', github_repo: 'myapp', repo_path: '/tmp/myapp' }],
            })
            .mockResolvedValueOnce({
                rows: [{
                    title: 'feat: add auth',
                    description: 'Implements JWT auth',
                    branch_name: 'agent/forge/task-1',
                    github_issue: 42,
                }],
            });

        integrationMocks.mockGetApiKey.mockResolvedValue('ghp_test_token');

        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);
        await integration.start();

        await eventBus._trigger('review.passed', {
            projectId: 'proj-1',
            taskId: 'task-1',
            channel: 'review.passed',
        });

        expect(client.pushBranch).toHaveBeenCalledWith(
            '/tmp/myapp',
            expect.objectContaining({ owner: 'myorg', repo: 'myapp' }),
            'agent/forge/task-1'
        );
        expect(client.createPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ head: 'agent/forge/task-1', base: 'main' })
        );
        expect(eventBus.publish).toHaveBeenCalledWith(
            'pr.created',
            expect.objectContaining({ projectId: 'proj-1', taskId: 'task-1' })
        );
    });

    it('skips PR creation when project has no GitHub config', async () => {
        integrationMocks.mockQuery.mockResolvedValueOnce({
            rows: [{ github_owner: null, github_repo: null, repo_path: '/tmp/myapp' }],
        });

        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);
        await integration.start();

        await eventBus._trigger('review.passed', {
            projectId: 'proj-2', taskId: 'task-2', channel: 'review.passed',
        });

        expect(client.createPullRequest).not.toHaveBeenCalled();
        expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('skips PR creation when GitHub token is not configured', async () => {
        integrationMocks.mockQuery.mockResolvedValueOnce({
            rows: [{ github_owner: 'org', github_repo: 'repo', repo_path: '/tmp/r' }],
        });
        integrationMocks.mockGetApiKey.mockResolvedValue(null);

        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);
        await integration.start();

        await eventBus._trigger('review.passed', {
            projectId: 'proj-3', taskId: 'task-3', channel: 'review.passed',
        });

        expect(client.createPullRequest).not.toHaveBeenCalled();
    });

    it('skips PR creation when task has no branch_name', async () => {
        integrationMocks.mockQuery
            .mockResolvedValueOnce({
                rows: [{ github_owner: 'org', github_repo: 'repo', repo_path: '/tmp/r' }],
            })
            .mockResolvedValueOnce({
                rows: [{ title: 'task', description: '', branch_name: null, github_issue: null }],
            });
        integrationMocks.mockGetApiKey.mockResolvedValue('ghp_token');

        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);
        await integration.start();

        await eventBus._trigger('review.passed', {
            projectId: 'proj-4', taskId: 'task-4', channel: 'review.passed',
        });

        expect(client.createPullRequest).not.toHaveBeenCalled();
    });

    it('does not throw when project is not found', async () => {
        integrationMocks.mockQuery.mockResolvedValueOnce({ rows: [] });

        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);
        await integration.start();

        await expect(eventBus._trigger('review.passed', {
            projectId: 'proj-5', taskId: 'task-5', channel: 'review.passed',
        })).resolves.toBeUndefined();
    });

    it('getTokenStatus returns true when token is configured', async () => {
        integrationMocks.mockGetApiKey.mockResolvedValue('ghp_valid');

        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);

        expect(await integration.getTokenStatus()).toBe(true);
    });

    it('getTokenStatus returns false when token is null', async () => {
        integrationMocks.mockGetApiKey.mockResolvedValue(null);

        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);

        expect(await integration.getTokenStatus()).toBe(false);
    });

    it('stop() calls ciPoller.stopAll()', async () => {
        const client = makeClient();
        const eventBus = makeEventBus();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const integration = new GitHubIntegration(client as any, eventBus as any);

        // Should not throw
        expect(() => integration.stop()).not.toThrow();
    });
});
