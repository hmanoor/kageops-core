/**
 * KageOps GitHub Integration Facade
 *
 * Subscribes to KageOps events and orchestrates GitHub actions:
 *   - review.passed  → push branch → open PR → start CI polling
 *   - pr.created     → start CI poller for the new PR's head SHA
 *
 * Completely inert when GitHub is not configured for a project.
 * No modification to Sensei required — this is a pure event subscriber.
 */

import { query } from '../db/client';
import { getApiKey } from '../main/secret-store';
import { createLogger } from '../shared/logger';
import { GitHubClient } from './github-client';
import { PRCreator } from './pr-creator';
import { CIPoller } from './ci-poller';
import type { EventBus, EventPayload } from '../orchestrator/event-bus';

const log = createLogger('GitHubIntegration');

const DEFAULT_BASE_BRANCH = 'main';

// ── Types ─────────────────────────────────────────────

interface ProjectGitHubRow {
    github_owner: string | null;
    github_repo: string | null;
    repo_path: string;
}

interface TaskGitHubRow {
    title: string;
    description: string | null;
    branch_name: string | null;
    github_issue: number | null;
}

// ── GitHub Integration ────────────────────────────────

export class GitHubIntegration {
    private readonly client: GitHubClient;
    private readonly prCreator: PRCreator;
    private readonly ciPoller: CIPoller;
    private readonly eventBus: EventBus;

    constructor(client: GitHubClient, eventBus: EventBus) {
        this.client = client;
        this.prCreator = new PRCreator(client);
        this.ciPoller = new CIPoller(client, eventBus);
        this.eventBus = eventBus;
    }

    /**
     * Subscribe to relevant events. Call once at bootstrap.
     */
    async start(): Promise<void> {
        await this.eventBus.subscribe('review.passed', (event) => this.onReviewPassed(event));
        log.info('GitHubIntegration started — listening for review.passed events');
    }

    /**
     * Stop CI poller and clean up.
     */
    stop(): void {
        this.ciPoller.stopAll();
        log.info('GitHubIntegration stopped');
    }

    /**
     * Check whether a GitHub token is stored.
     */
    async getTokenStatus(): Promise<boolean> {
        const token = await getApiKey('github');
        return token !== null && token !== '';
    }

    // ── Event handlers ────────────────────────────────

    private async onReviewPassed(event: EventPayload): Promise<void> {
        const taskId = event.taskId;
        const projectId = event.projectId;
        if (taskId === undefined || projectId === undefined) return;

        // Load project GitHub config
        const projectRows = await query<ProjectGitHubRow>(
            'SELECT github_owner, github_repo, repo_path FROM projects WHERE id = $1',
            [projectId]
        );
        if (projectRows.rows.length === 0) return;

        const project = projectRows.rows[0];
        if (project.github_owner === null || project.github_repo === null) {
            log.debug({ projectId }, 'No GitHub config — skipping PR creation');
            return;
        }

        // Load GitHub token
        const token = await getApiKey('github');
        if (token === null || token === '') {
            log.warn({ projectId }, 'GitHub token not configured — skipping PR creation');
            return;
        }

        // Load task metadata
        const taskRows = await query<TaskGitHubRow>(
            'SELECT title, description, branch_name, github_issue FROM tasks WHERE id = $1',
            [taskId]
        );
        if (taskRows.rows.length === 0) return;

        const task = taskRows.rows[0];
        const branchName = task.branch_name;
        if (branchName === null) {
            log.warn({ taskId }, 'Task has no branch_name — skipping PR creation');
            return;
        }

        const config = {
            owner: project.github_owner,
            repo: project.github_repo,
            token,
        };

        log.info({ taskId, branchName }, 'Creating PR for reviewed task');

        try {
            const result = await this.prCreator.createPR({
                config,
                repoPath: project.repo_path,
                branchName,
                baseBranch: DEFAULT_BASE_BRANCH,
                taskTitle: task.title,
                taskDescription: task.description ?? '',
                githubIssue: task.github_issue,
            });

            // Publish pr.created event
            await this.eventBus.publish('pr.created', {
                projectId,
                taskId,
                data: {
                    prNumber: result.prNumber,
                    prUrl: result.prUrl,
                    headSha: result.headSha,
                    branchName,
                },
            });

            // Start CI polling if we have a head SHA
            if (result.headSha !== '') {
                this.ciPoller.pollForCompletion(config, result.headSha, projectId, taskId);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ taskId, err: msg }, 'Failed to create PR');
        }
    }
}

// ── Singleton ─────────────────────────────────────────

let instance: GitHubIntegration | null = null;

export function getGitHubIntegration(
    client: GitHubClient,
    eventBus: EventBus
): GitHubIntegration {
    if (instance === null) {
        instance = new GitHubIntegration(client, eventBus);
    }
    return instance;
}

export function resetGitHubIntegrationForTesting(): void {
    instance = null;
}
