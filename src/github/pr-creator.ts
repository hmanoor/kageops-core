/**
 * KageOps PR Creator
 *
 * Orchestrates the full PR creation workflow:
 *   1. Push the agent branch to GitHub remote
 *   2. Generate PR title and body from task metadata
 *   3. Call GitHubClient.createPullRequest()
 *
 * Handles edge cases: remote not configured, duplicate PR (already open).
 */

import { createLogger } from '../shared/logger';
import { GitHubClient, GitHubApiError } from './github-client';
import type { GitHubConfig, GitHubPRResponse } from './github-types';

const log = createLogger('PRCreator');

// ── Types ─────────────────────────────────────────────

export interface CreatePROptions {
    readonly config: GitHubConfig;
    readonly repoPath: string;
    readonly branchName: string;
    readonly baseBranch: string;
    readonly taskTitle: string;
    readonly taskDescription: string;
    /** GitHub issue number to link with "Fixes #N" */
    readonly githubIssue: number | null;
}

export interface PRCreationResult {
    readonly prNumber: number;
    readonly prUrl: string;
    readonly headSha: string;
    /** True if PR already existed (was not newly created) */
    readonly alreadyExisted: boolean;
}

// ── PR Creator ────────────────────────────────────────

export class PRCreator {
    private readonly client: GitHubClient;

    constructor(client: GitHubClient) {
        this.client = client;
    }

    async createPR(options: CreatePROptions): Promise<PRCreationResult> {
        const {
            config,
            repoPath,
            branchName,
            baseBranch,
            taskTitle,
            taskDescription,
            githubIssue,
        } = options;

        // 1. Push branch to remote
        await this.client.pushBranch(repoPath, config, branchName);

        // 2. Generate PR body
        const body = buildPRBody(taskDescription, githubIssue);

        // 3. Create PR
        let pr: GitHubPRResponse;
        let alreadyExisted = false;

        try {
            pr = await this.client.createPullRequest({
                config,
                head: branchName,
                base: baseBranch,
                title: taskTitle,
                body,
            });
            log.info({ prNumber: pr.number, branchName }, 'Pull request created');
        } catch (err) {
            if (err instanceof GitHubApiError && err.status === 422) {
                // 422 Unprocessable — PR may already exist for this branch
                log.info({ branchName }, 'PR already exists or validation error — treating as pre-existing');
                alreadyExisted = true;
                // We can't get the existing PR number without a search, so return a placeholder
                return {
                    prNumber: 0,
                    prUrl: `https://github.com/${config.owner}/${config.repo}/pulls`,
                    headSha: '',
                    alreadyExisted: true,
                };
            }
            throw err;
        }

        return {
            prNumber: pr.number,
            prUrl: pr.html_url,
            headSha: pr.head.sha,
            alreadyExisted,
        };
    }
}

// ── Helpers ───────────────────────────────────────────

function buildPRBody(description: string, githubIssue: number | null): string {
    const parts: string[] = [];

    if (description.trim().length > 0) {
        parts.push(description.trim());
    }

    if (githubIssue !== null) {
        parts.push(`\nFixes #${githubIssue}`);
    }

    parts.push('\n---\n*Opened automatically by KageOps*');

    return parts.join('\n');
}
