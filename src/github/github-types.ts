/**
 * KageOps GitHub Integration — Type Definitions
 *
 * Interfaces for GitHub REST API v3 requests/responses used by the
 * PR creator, CI poller, and workflow dispatch.
 */

// ── Configuration ─────────────────────────────────────

export interface GitHubConfig {
    readonly owner: string;
    readonly repo: string;
    readonly token: string;
}

// ── Pull Request ──────────────────────────────────────

export interface CreatePRParams {
    readonly config: GitHubConfig;
    readonly head: string;        // branch name
    readonly base: string;        // target branch (usually 'main')
    readonly title: string;
    readonly body: string;
    readonly draft?: boolean;
}

export interface GitHubPRResponse {
    readonly number: number;
    readonly html_url: string;
    readonly head: { readonly sha: string };
    readonly state: 'open' | 'closed' | 'merged';
}

// ── Check Runs ────────────────────────────────────────

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';
export type CheckRunConclusion =
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null;

export interface GitHubCheckRun {
    readonly id: number;
    readonly name: string;
    readonly status: CheckRunStatus;
    readonly conclusion: CheckRunConclusion;
    readonly html_url: string;
}

export interface GitHubCheckRunsResponse {
    readonly total_count: number;
    readonly check_runs: readonly GitHubCheckRun[];
}

// ── Workflow Dispatch ─────────────────────────────────

export interface WorkflowDispatchParams {
    readonly config: GitHubConfig;
    readonly workflowId: string;          // filename or numeric ID
    readonly ref: string;                  // branch/tag to run on
    readonly inputs?: Record<string, string>;
}

// ── Rate Limit ────────────────────────────────────────

export interface GitHubRateLimitInfo {
    readonly remaining: number;
    readonly resetAt: number;  // Unix timestamp
}

// ── User validation ───────────────────────────────────

export interface GitHubUserResponse {
    readonly login: string;
    readonly id: number;
}

// ── Error ─────────────────────────────────────────────

export interface GitHubApiError {
    readonly message: string;
    readonly status: number;
    readonly isRateLimit: boolean;
    readonly isAuthError: boolean;
    readonly isNotFound: boolean;
}
