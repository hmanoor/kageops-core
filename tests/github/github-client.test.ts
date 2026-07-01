/**
 * Tests for github-client.ts
 *
 * Tests the GitHub REST API client using mocked fetch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────

const clientMocks = vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockSpawn: vi.fn(),
}));

vi.stubGlobal('fetch', clientMocks.mockFetch);

vi.mock('child_process', () => ({
    spawn: clientMocks.mockSpawn,
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
    GitHubClient,
    GitHubApiError,
    getGitHubClient,
    resetGitHubClientForTesting,
} from '../../src/github/github-client';

// ── Helpers ───────────────────────────────────────────

function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    const headerMap = new Map(Object.entries({
        'X-RateLimit-Remaining': '4999',
        'X-RateLimit-Reset': '0',
        ...headers,
    }));

    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (key: string) => headerMap.get(key) ?? null,
        },
        json: async () => body,
    } as unknown as Response;
}

const TEST_CONFIG = {
    owner: 'test-owner',
    repo: 'test-repo',
    token: 'ghp_test_token',
};

// ── Tests ─────────────────────────────────────────────

describe('GitHubClient', () => {
    let client: GitHubClient;

    beforeEach(() => {
        resetGitHubClientForTesting();
        clientMocks.mockFetch.mockReset();
        clientMocks.mockSpawn.mockReset();
        client = new GitHubClient();
    });

    describe('validateToken()', () => {
        it('returns login on success', async () => {
            clientMocks.mockFetch.mockResolvedValueOnce(
                makeResponse(200, { login: 'octocat', id: 12345 })
            );

            const login = await client.validateToken('ghp_test');
            expect(login).toBe('octocat');
        });

        it('throws GitHubApiError on 401 with isAuthError=true', async () => {
            clientMocks.mockFetch.mockResolvedValue(
                makeResponse(401, { message: 'Bad credentials' })
            );

            let caught: unknown;
            try {
                await client.validateToken('bad_token');
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(GitHubApiError);
            expect((caught as GitHubApiError).isAuthError).toBe(true);
            expect((caught as GitHubApiError).status).toBe(401);
        });
    });

    describe('createPullRequest()', () => {
        it('posts to /repos/owner/repo/pulls and returns PR data', async () => {
            clientMocks.mockFetch.mockResolvedValueOnce(
                makeResponse(201, {
                    number: 42,
                    html_url: 'https://github.com/test-owner/test-repo/pull/42',
                    head: { sha: 'abc123' },
                    state: 'open',
                })
            );

            const pr = await client.createPullRequest({
                config: TEST_CONFIG,
                head: 'agent/forge/task-1',
                base: 'main',
                title: 'feat: implement login',
                body: 'Implements the login flow.\n\nFixes #7',
            });

            expect(pr.number).toBe(42);
            expect(pr.html_url).toContain('/pull/42');

            const [url, opts] = clientMocks.mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toContain('/repos/test-owner/test-repo/pulls');
            expect(opts.method).toBe('POST');

            const body = JSON.parse(opts.body as string);
            expect(body.head).toBe('agent/forge/task-1');
            expect(body.base).toBe('main');
        });

        it('throws GitHubApiError on 422 (e.g. branch not found)', async () => {
            clientMocks.mockFetch.mockResolvedValueOnce(
                makeResponse(422, { message: 'Validation Failed' })
            );

            await expect(client.createPullRequest({
                config: TEST_CONFIG,
                head: 'nonexistent-branch',
                base: 'main',
                title: 'Test',
                body: '',
            })).rejects.toThrow(GitHubApiError);
        });

        it('throws GitHubApiError on network failure', async () => {
            clientMocks.mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            await expect(client.createPullRequest({
                config: TEST_CONFIG,
                head: 'branch',
                base: 'main',
                title: 'Test',
                body: '',
            })).rejects.toThrow(GitHubApiError);
        });

        it('includes Authorization header with Bearer token', async () => {
            clientMocks.mockFetch.mockResolvedValueOnce(
                makeResponse(201, { number: 1, html_url: 'x', head: { sha: 'abc' }, state: 'open' })
            );

            await client.createPullRequest({
                config: { ...TEST_CONFIG, token: 'ghp_my_token' },
                head: 'branch',
                base: 'main',
                title: 'Title',
                body: 'Body',
            });

            const [, opts] = clientMocks.mockFetch.mock.calls[0] as [string, RequestInit];
            const headers = opts.headers as Record<string, string>;
            expect(headers['Authorization']).toBe('Bearer ghp_my_token');
        });
    });

    describe('getCheckRuns()', () => {
        it('returns check runs for a commit SHA', async () => {
            clientMocks.mockFetch.mockResolvedValueOnce(
                makeResponse(200, {
                    total_count: 2,
                    check_runs: [
                        { id: 1, name: 'build', status: 'completed', conclusion: 'success', html_url: 'x' },
                        { id: 2, name: 'test', status: 'completed', conclusion: 'success', html_url: 'y' },
                    ],
                })
            );

            const result = await client.getCheckRuns(TEST_CONFIG, 'abc123');
            expect(result.total_count).toBe(2);
            expect(result.check_runs).toHaveLength(2);
        });

        it('URL-encodes the ref parameter', async () => {
            clientMocks.mockFetch.mockResolvedValueOnce(
                makeResponse(200, { total_count: 0, check_runs: [] })
            );

            await client.getCheckRuns(TEST_CONFIG, 'refs/heads/agent/forge/task-1');

            const [url] = clientMocks.mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).not.toContain('refs/heads/agent/forge/task-1');
            expect(url).toContain(encodeURIComponent('refs/heads/agent/forge/task-1'));
        });
    });

    describe('triggerWorkflowDispatch()', () => {
        it('sends POST with ref and inputs to workflow dispatch endpoint', async () => {
            clientMocks.mockFetch.mockResolvedValueOnce(
                makeResponse(204, null)
            );

            await client.triggerWorkflowDispatch({
                config: TEST_CONFIG,
                workflowId: 'deploy.yml',
                ref: 'main',
                inputs: { environment: 'staging' },
            });

            const [url, opts] = clientMocks.mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toContain('workflows/deploy.yml/dispatches');
            expect(opts.method).toBe('POST');

            const body = JSON.parse(opts.body as string);
            expect(body.ref).toBe('main');
            expect(body.inputs.environment).toBe('staging');
        });
    });

    describe('rate limit tracking', () => {
        it('updates rateLimitInfo after each request', async () => {
            clientMocks.mockFetch.mockResolvedValueOnce(
                makeResponse(200, { login: 'user', id: 1 }, {
                    'X-RateLimit-Remaining': '42',
                    'X-RateLimit-Reset': '1700000000',
                })
            );

            await client.validateToken('token');
            expect(client.rateLimitInfo.remaining).toBe(42);
            expect(client.rateLimitInfo.resetAt).toBe(1700000000);
        });
    });

    describe('getGitHubClient() singleton', () => {
        it('returns same instance on repeated calls', () => {
            const a = getGitHubClient();
            const b = getGitHubClient();
            expect(a).toBe(b);
        });

        it('resetGitHubClientForTesting creates fresh instance', () => {
            const a = getGitHubClient();
            resetGitHubClientForTesting();
            const b = getGitHubClient();
            expect(a).not.toBe(b);
        });
    });
});
