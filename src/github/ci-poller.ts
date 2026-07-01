/**
 * KageOps CI Poller
 *
 * Polls GitHub Check Runs for a commit SHA after a PR is created.
 * Emits build.passed or build.failed events when CI completes.
 * Stops after 20 minutes or when stopAll() is called.
 *
 * Design notes:
 * - Uses setInterval-based polling (not recursive setTimeout) for testability
 * - Tracks active polls in a Map keyed by commitSha
 * - Rate-limit aware: backs off when GitHub remaining < 100
 * - No-CI repos: times out after 5 minutes and emits build.passed with note
 */

import { query } from '../db/client';
import { createLogger } from '../shared/logger';
import { GitHubClient } from './github-client';
import type { EventBus } from '../orchestrator/event-bus';
import type { GitHubConfig, CheckRunConclusion } from './github-types';

const log = createLogger('CIPoller');

const POLL_INTERVAL_MS = 30_000;      // 30 seconds
const SLOW_POLL_INTERVAL_MS = 120_000; // 2 minutes (rate limit backoff)
const MAX_POLL_DURATION_MS = 20 * 60_000; // 20 minutes
const NO_CI_TIMEOUT_MS = 5 * 60_000;   // 5 minutes — no checks found
const MAX_CONCURRENT_POLLS = 10;

const FAILING_CONCLUSIONS: ReadonlySet<CheckRunConclusion> = new Set([
    'failure', 'cancelled', 'timed_out', 'action_required',
]);

const PASSING_CONCLUSIONS: ReadonlySet<CheckRunConclusion> = new Set([
    'success', 'neutral', 'skipped',
]);

// ── Poll state ────────────────────────────────────────

interface ActivePoll {
    readonly projectId: string;
    readonly taskId: string;
    readonly startedAt: number;
    timerId: ReturnType<typeof setInterval> | null;
    firstCheckSeenAt: number | null;
}

// ── CI Poller ─────────────────────────────────────────

export class CIPoller {
    private readonly client: GitHubClient;
    private readonly eventBus: EventBus;
    private readonly active = new Map<string, ActivePoll>();

    constructor(client: GitHubClient, eventBus: EventBus) {
        this.client = client;
        this.eventBus = eventBus;
    }

    /**
     * Begin polling check runs for `commitSha`.
     * Safe to call with the same SHA twice — second call is ignored.
     */
    pollForCompletion(
        config: GitHubConfig,
        commitSha: string,
        projectId: string,
        taskId: string
    ): void {
        if (this.active.has(commitSha)) {
            log.debug({ commitSha }, 'Already polling — skipping duplicate');
            return;
        }

        if (this.active.size >= MAX_CONCURRENT_POLLS) {
            log.warn({ commitSha }, `Max concurrent polls (${MAX_CONCURRENT_POLLS}) reached — skipping`);
            return;
        }

        const poll: ActivePoll = {
            projectId,
            taskId,
            startedAt: Date.now(),
            timerId: null,
            firstCheckSeenAt: null,
        };

        this.active.set(commitSha, poll);

        const run = async () => {
            try {
                await this.tick(config, commitSha, poll);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.error({ commitSha, err: msg }, 'CI poll tick error');
            }
        };

        const intervalMs = this.client.rateLimitInfo.remaining < 100
            ? SLOW_POLL_INTERVAL_MS
            : POLL_INTERVAL_MS;

        poll.timerId = setInterval(() => void run(), intervalMs);

        // Run immediately on first start
        void run();

        log.info({ commitSha, projectId }, 'Started CI polling');
    }

    /**
     * Stop all active polls (e.g., on app shutdown).
     */
    stopAll(): void {
        for (const [sha, poll] of this.active) {
            if (poll.timerId !== null) {
                clearInterval(poll.timerId);
            }
            log.debug({ sha }, 'Stopped CI poll');
        }
        this.active.clear();
    }

    get activePollCount(): number {
        return this.active.size;
    }

    // ── Private ───────────────────────────────────────

    private async tick(
        config: GitHubConfig,
        commitSha: string,
        poll: ActivePoll
    ): Promise<void> {
        const elapsed = Date.now() - poll.startedAt;

        // Hard timeout
        if (elapsed > MAX_POLL_DURATION_MS) {
            log.warn({ commitSha }, 'CI poll max duration exceeded — treating as failed');
            this.finish(commitSha, poll, false, 'CI timeout after 20 minutes');
            return;
        }

        const response = await this.client.getCheckRuns(config, commitSha);
        const runs = response.check_runs;

        // No checks found yet
        if (runs.length === 0) {
            if (poll.firstCheckSeenAt === null && elapsed > NO_CI_TIMEOUT_MS) {
                log.info({ commitSha }, 'No CI checks found within 5 minutes — treating as passed (no CI configured)');
                this.finish(commitSha, poll, true, 'No CI checks configured');
            }
            return;
        }

        // Record when we first saw checks
        if (poll.firstCheckSeenAt === null) {
            poll.firstCheckSeenAt = Date.now();
        }

        // Check if any are still running
        const inProgress = runs.some(
            (r) => r.status === 'queued' || r.status === 'in_progress'
        );

        if (inProgress) {
            log.debug({ commitSha, total: runs.length }, 'Checks still in progress');
            return;
        }

        // All completed — determine overall result
        const anyFailing = runs.some(
            (r) => r.conclusion !== null && FAILING_CONCLUSIONS.has(r.conclusion)
        );

        const allPassing = runs.every(
            (r) => r.conclusion !== null && PASSING_CONCLUSIONS.has(r.conclusion)
        );

        const passed = !anyFailing && allPassing;
        const summary = passed
            ? `All ${runs.length} checks passed`
            : `${runs.filter((r) => r.conclusion !== null && FAILING_CONCLUSIONS.has(r.conclusion)).length} of ${runs.length} checks failed`;

        this.finish(commitSha, poll, passed, summary);
    }

    private finish(
        commitSha: string,
        poll: ActivePoll,
        passed: boolean,
        summary: string
    ): void {
        const poll_ = this.active.get(commitSha);
        if (poll_ === undefined) return; // already removed

        if (poll_.timerId !== null) {
            clearInterval(poll_.timerId);
        }
        this.active.delete(commitSha);

        const channel = passed ? 'build.passed' : 'build.failed';
        log.info({ commitSha, passed, summary }, `CI ${passed ? 'passed' : 'failed'}`);

        // Record in build_status table and publish event
        void this.recordAndPublish(commitSha, poll, passed, summary, channel);
    }

    private async recordAndPublish(
        commitSha: string,
        poll: ActivePoll,
        passed: boolean,
        summary: string,
        channel: 'build.passed' | 'build.failed'
    ): Promise<void> {
        try {
            await query(
                `INSERT INTO build_status (project_id, pipeline, run_id, status, commit_sha, log_summary)
                 VALUES ($1, 'github-actions', $2, $3, $4, $5)
                 ON CONFLICT DO NOTHING`,
                [
                    poll.projectId,
                    `ci-${commitSha.slice(0, 8)}`,
                    passed ? 'success' : 'failure',
                    commitSha,
                    summary,
                ]
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, 'Failed to record build status');
        }

        await this.eventBus.publish(channel, {
            projectId: poll.projectId,
            taskId: poll.taskId,
            data: { commitSha, summary, passed },
        });
    }
}
