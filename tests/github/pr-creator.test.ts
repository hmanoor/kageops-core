/**
 * Tests for pr-creator.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PRCreator } from '../../src/github/pr-creator';
import { GitHubApiError } from '../../src/github/github-client';

vi.mock('../../src/shared/logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    }),
}));

// ── Helpers ───────────────────────────────────────────

function makeClient() {
    return {
        pushBranch: vi.fn(async () => undefined),
        createPullRequest: vi.fn(async () => ({
            number: 42,
            html_url: 'https://github.com/owner/repo/pull/42',
            head: { sha: 'abc123' },
            state: 'open' as const,
        })),
        getCheckRuns: vi.fn(),
        triggerWorkflowDispatch: vi.fn(),
        validateToken: vi.fn(),
        rateLimitInfo: { remaining: 5000, resetAt: 0 },
    };
}

const BASE_OPTIONS = {
    config: { owner: 'test-owner', repo: 'test-repo', token: 'ghp_test' },
    repoPath: '/tmp/test-repo',
    branchName: 'agent/forge/task-abc',
    baseBranch: 'main',
    taskTitle: 'feat: implement login',
    taskDescription: 'Implements the login flow with JWT tokens.',
    githubIssue: null,
};

// ── Tests ─────────────────────────────────────────────

describe('PRCreator', () => {
    let client: ReturnType<typeof makeClient>;
    let creator: PRCreator;

    beforeEach(() => {
        client = makeClient();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        creator = new PRCreator(client as any);
    });

    it('pushes branch then creates PR', async () => {
        const result = await creator.createPR(BASE_OPTIONS);

        expect(client.pushBranch).toHaveBeenCalledWith(
            '/tmp/test-repo',
            BASE_OPTIONS.config,
            'agent/forge/task-abc'
        );
        expect(client.createPullRequest).toHaveBeenCalledOnce();
        expect(result.prNumber).toBe(42);
        expect(result.prUrl).toContain('/pull/42');
        expect(result.headSha).toBe('abc123');
        expect(result.alreadyExisted).toBe(false);
    });

    it('includes Fixes #N in PR body when githubIssue is set', async () => {
        await creator.createPR({ ...BASE_OPTIONS, githubIssue: 7 });

        const [params] = client.createPullRequest.mock.calls[0] as [{ body: string }[]];
        expect(params.body).toContain('Fixes #7');
    });

    it('does NOT include Fixes when githubIssue is null', async () => {
        await creator.createPR({ ...BASE_OPTIONS, githubIssue: null });

        const [params] = client.createPullRequest.mock.calls[0] as [{ body: string }[]];
        expect(params.body).not.toContain('Fixes #');
    });

    it('PR body includes task description', async () => {
        await creator.createPR(BASE_OPTIONS);

        const [params] = client.createPullRequest.mock.calls[0] as [{ body: string }[]];
        expect(params.body).toContain('Implements the login flow with JWT tokens.');
    });

    it('PR body includes KageOps attribution footer', async () => {
        await creator.createPR(BASE_OPTIONS);

        const [params] = client.createPullRequest.mock.calls[0] as [{ body: string }[]];
        expect(params.body).toContain('KageOps');
    });

    it('uses taskTitle as PR title', async () => {
        await creator.createPR(BASE_OPTIONS);

        const [params] = client.createPullRequest.mock.calls[0] as [{ title: string }[]];
        expect(params.title).toBe('feat: implement login');
    });

    it('returns alreadyExisted=true on 422 from GitHub', async () => {
        client.createPullRequest.mockRejectedValueOnce(
            new GitHubApiError('Validation Failed', 422)
        );

        const result = await creator.createPR(BASE_OPTIONS);

        expect(result.alreadyExisted).toBe(true);
        expect(result.prNumber).toBe(0);
    });

    it('propagates non-422 errors', async () => {
        client.createPullRequest.mockRejectedValueOnce(
            new GitHubApiError('Bad credentials', 401)
        );

        await expect(creator.createPR(BASE_OPTIONS)).rejects.toThrow(GitHubApiError);
    });

    it('propagates push errors', async () => {
        client.pushBranch.mockRejectedValueOnce(new Error('git push failed'));

        await expect(creator.createPR(BASE_OPTIONS)).rejects.toThrow('git push failed');
        // createPullRequest should not be called if push failed
        expect(client.createPullRequest).not.toHaveBeenCalled();
    });
});
