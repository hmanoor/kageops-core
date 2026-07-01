/**
 * KageOps GitHub REST API Client
 *
 * Low-level wrapper around GitHub REST API v3 using Node's native fetch.
 * Handles auth, rate limits, and structured error reporting.
 * No npm dependencies — relies on Node 20 global fetch.
 */

import { spawn } from 'child_process';
import { createLogger } from '../shared/logger';
import type {
    GitHubConfig,
    CreatePRParams,
    GitHubPRResponse,
    GitHubCheckRunsResponse,
    WorkflowDispatchParams,
    GitHubRateLimitInfo,
    GitHubUserResponse,
} from './github-types';

const log = createLogger('GitHubClient');

const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'KageOps/0.9';

// ── Error class ───────────────────────────────────────

export class GitHubApiError extends Error {
    readonly status: number;
    readonly isRateLimit: boolean;
    readonly isAuthError: boolean;
    readonly isNotFound: boolean;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'GitHubApiError';
        this.status = status;
        this.isRateLimit = status === 403 || status === 429;
        this.isAuthError = status === 401;
        this.isNotFound = status === 404;
    }
}

// ── Client ────────────────────────────────────────────

export class GitHubClient {
    private lastRateLimit: GitHubRateLimitInfo = { remaining: 5000, resetAt: 0 };

    /**
     * Validate a token by fetching the authenticated user.
     * Returns the GitHub login on success, throws GitHubApiError on failure.
     */
    async validateToken(token: string): Promise<string> {
        const data = await this.request<GitHubUserResponse>(
            'GET',
            '/user',
            undefined,
            token
        );
        return data.login;
    }

    /**
     * Create a pull request.
     */
    async createPullRequest(params: CreatePRParams): Promise<GitHubPRResponse> {
        const { config, head, base, title, body, draft = false } = params;
        const path = `/repos/${config.owner}/${config.repo}/pulls`;

        return this.request<GitHubPRResponse>('POST', path, { head, base, title, body, draft }, config.token);
    }

    /**
     * Get all check runs for a commit SHA.
     */
    async getCheckRuns(config: GitHubConfig, ref: string): Promise<GitHubCheckRunsResponse> {
        const path = `/repos/${config.owner}/${config.repo}/commits/${encodeURIComponent(ref)}/check-runs`;
        return this.request<GitHubCheckRunsResponse>('GET', path, undefined, config.token);
    }

    /**
     * Trigger a workflow_dispatch event.
     */
    async triggerWorkflowDispatch(params: WorkflowDispatchParams): Promise<void> {
        const { config, workflowId, ref, inputs } = params;
        const path = `/repos/${config.owner}/${config.repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;
        await this.request<void>('POST', path, { ref, inputs: inputs ?? {} }, config.token);
    }

    /**
     * Push a local branch to the remote using git.
     * Adds origin remote if not present.
     * Uses --force-with-lease so agents can safely re-push their own branches.
     */
    async pushBranch(
        repoPath: string,
        config: GitHubConfig,
        branchName: string
    ): Promise<void> {
        const remoteUrl = `https://x-access-token:${config.token}@github.com/${config.owner}/${config.repo}.git`;

        // Ensure origin points to the right repo
        await this.runGit(repoPath, ['remote', 'get-url', 'origin'])
            .then(async (existingUrl) => {
                const normalizedExisting = existingUrl.replace(/x-access-token:[^@]+@/, '');
                const expectedBase = `github.com/${config.owner}/${config.repo}.git`;
                if (!normalizedExisting.includes(expectedBase)) {
                    log.warn({ existingUrl: normalizedExisting }, 'origin points elsewhere — skipping push');
                    throw new Error(`Remote origin does not match configured repo ${config.owner}/${config.repo}`);
                }
            })
            .catch(async (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('No such remote')) {
                    // Add origin
                    await this.runGit(repoPath, ['remote', 'add', 'origin', remoteUrl]);
                } else {
                    throw err;
                }
            });

        // Update origin URL with token (in case it was already set without auth)
        await this.runGit(repoPath, ['remote', 'set-url', 'origin', remoteUrl]);
        await this.runGit(repoPath, ['push', 'origin', `${branchName}:${branchName}`, '--force-with-lease']);

        log.info({ branchName }, 'Branch pushed to GitHub');
    }

    /**
     * Current rate limit state (updated after every request).
     */
    get rateLimitInfo(): GitHubRateLimitInfo {
        return this.lastRateLimit;
    }

    // ── Private helpers ───────────────────────────────

    private async request<T>(
        method: string,
        path: string,
        body: unknown,
        token: string
    ): Promise<T> {
        const url = `${GITHUB_API_BASE}${path}`;
        const headers: Record<string, string> = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': USER_AGENT,
            'X-GitHub-Api-Version': '2022-11-28',
        };

        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new GitHubApiError(`Network error: ${msg}`, 0);
        }

        // Update rate limit tracking from response headers
        const remaining = parseInt(response.headers.get('X-RateLimit-Remaining') ?? '5000', 10);
        const resetAt = parseInt(response.headers.get('X-RateLimit-Reset') ?? '0', 10);
        this.lastRateLimit = { remaining, resetAt };

        if (remaining < 100) {
            log.warn({ remaining, resetAt }, 'GitHub rate limit running low');
        }

        // 204 No Content — success with no body
        if (response.status === 204) {
            return undefined as T;
        }

        let responseBody: unknown;
        try {
            responseBody = await response.json();
        } catch {
            responseBody = {};
        }

        if (!response.ok) {
            const message = isGitHubErrorBody(responseBody)
                ? responseBody.message
                : `GitHub API error ${response.status}`;

            log.warn({ status: response.status, path, message }, 'GitHub API request failed');
            throw new GitHubApiError(message, response.status);
        }

        return responseBody as T;
    }

    private runGit(cwd: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
            proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
                }
            });

            proc.on('error', (err) => {
                reject(new Error(`Failed to spawn git: ${err.message}`));
            });
        });
    }
}

// ── Type guard ────────────────────────────────────────

function isGitHubErrorBody(body: unknown): body is { message: string } {
    return typeof body === 'object' && body !== null && 'message' in body && typeof (body as Record<string, unknown>).message === 'string';
}

// ── Singleton ─────────────────────────────────────────

let instance: GitHubClient | null = null;

export function getGitHubClient(): GitHubClient {
    if (instance === null) {
        instance = new GitHubClient();
    }
    return instance;
}

export function resetGitHubClientForTesting(): void {
    instance = null;
}
