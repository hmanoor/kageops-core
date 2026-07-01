/**
 * KageOps Learning — Live Evaluator (B-471, APO iter 2)
 *
 * Converts a candidate system prompt into a real reward score by running
 * it against a held-out task set. For each task we call the injected
 * `sendPrompt` with the candidate as the system prompt and the task's
 * `description` as the user prompt, then map the result into a synthetic
 * `AgentLog` and reuse `deriveReward` / `aggregateRewards` so scoring is
 * consistent with the post-hoc reward-from-logs path.
 *
 * Scope (MVP):
 *   - Sequential task execution — simplicity over parallelism for the
 *     first cut. Parallel eval is cheap to add later once a concurrency
 *     budget is agreed.
 *   - Cost-gated: once total spend on a single candidate crosses
 *     `budgetCapUsd`, remaining tasks score `-0.5` without being sent.
 *   - LLM errors count as failures (`-0.5`), not exceptions. The beam
 *     search should keep moving even if one provider is flaky.
 *
 * Not in scope here:
 *   - LLM-as-judge (quality scoring beyond cost penalty). Today's reward
 *     signal only distinguishes "completed" vs "truncated" vs "failed".
 *     Adding a judge is a follow-up once we have a held-out task corpus
 *     to validate the judge itself against.
 *   - Nightly scheduler, Command Center UI — those consume this module.
 */

import { createLogger } from '../shared/logger';
import type { SendPromptFn } from './prompt-mutator';
import type { EvalPromptFn, SampleTask } from './apo-engine';
import { aggregateRewards, deriveReward } from './reward-from-logs';
import type { AgentLog } from './types';

const log = createLogger('APO.LiveEval');

// ── Options ──────────────────────────────────────────

export interface LiveEvaluatorOptions {
    /** `ai-adapter.sendPrompt`-shaped callable. Injected for testability. */
    readonly sendPrompt: SendPromptFn;
    /** Model string (e.g. `openrouter/google/gemini-2.5-flash`). */
    readonly model: string;
    /** Max output tokens per task. Defaults to 512 — eval answers are short. */
    readonly maxTokens?: number;
    /** Temperature. Defaults to 0.3 for reproducibility across candidates. */
    readonly temperature?: number;
    /**
     * Hard per-candidate spend cap in USD. Once total cost for a single
     * `evalPrompt(candidate, tasks)` call crosses this, remaining tasks
     * score `-0.5` and no further LLM requests are sent.
     *
     * Default `0.10` — with 10 tasks at ~$0.005 each on a budget model
     * the cap is ~3× the expected spend, leaving headroom for retries
     * but hard-killing runaway candidates.
     */
    readonly budgetCapUsd?: number;
    /** Per-task wall-clock timeout in ms. Defaults to 30_000. */
    readonly perTaskTimeoutMs?: number;
    /**
     * Optional observer called with `(task, outcome)` after every task,
     * regardless of success/failure. Useful for UI streaming or tests.
     */
    readonly onTaskResult?: (
        task: SampleTask,
        outcome: TaskOutcome
    ) => void;
}

export interface TaskOutcome {
    readonly taskId: string;
    readonly status: 'success' | 'failed' | 'escalated' | 'skipped';
    readonly costUsd: number;
    readonly tokensOut: number;
    readonly durationMs: number;
    readonly reward: number;
    readonly error: string | null;
}

// ── Defaults ─────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_BUDGET_CAP_USD = 0.10;
const DEFAULT_PER_TASK_TIMEOUT_MS = 30_000;

const SKIPPED_REWARD = -0.5;
const FAILED_REWARD = -0.5;
const ESCALATED_REWARD = -0.2;

// ── Factory ──────────────────────────────────────────

/**
 * Build an `EvalPromptFn` that runs a candidate prompt against a held-out
 * task set and returns the mean reward.
 *
 * Usage:
 *   ```
 *   const evalPrompt = createLiveEvaluator({ sendPrompt, model: '...' });
 *   const result = await optimize(agentName, baseline, tasks, {
 *     sendPrompt, evalPrompt, rounds: 5,
 *   });
 *   ```
 */
export function createLiveEvaluator(opts: LiveEvaluatorOptions): EvalPromptFn {
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
    const budgetCapUsd = opts.budgetCapUsd ?? DEFAULT_BUDGET_CAP_USD;
    const perTaskTimeoutMs = opts.perTaskTimeoutMs ?? DEFAULT_PER_TASK_TIMEOUT_MS;

    return async function evalPrompt(
        candidatePrompt: string,
        sampleTasks: readonly SampleTask[]
    ): Promise<number> {
        if (sampleTasks.length === 0) {
            return 0;
        }

        const syntheticLogs: AgentLog[] = [];
        let totalCostUsd = 0;

        for (const task of sampleTasks) {
            if (totalCostUsd >= budgetCapUsd) {
                log.warn(
                    { taskId: task.id, totalCostUsd, budgetCapUsd },
                    'live-eval: budget cap hit — skipping remaining tasks'
                );
                const outcome: TaskOutcome = Object.freeze({
                    taskId: task.id,
                    status: 'skipped',
                    costUsd: 0,
                    tokensOut: 0,
                    durationMs: 0,
                    reward: SKIPPED_REWARD,
                    error: 'budget cap reached',
                });
                opts.onTaskResult?.(task, outcome);
                syntheticLogs.push(skippedLog(task));
                continue;
            }

            const outcome = await runOneTask(task, candidatePrompt, {
                sendPrompt: opts.sendPrompt,
                model: opts.model,
                maxTokens,
                temperature,
                perTaskTimeoutMs,
            });

            totalCostUsd += outcome.costUsd;
            syntheticLogs.push(toAgentLog(task, outcome));
            opts.onTaskResult?.(task, outcome);
        }

        const { mean } = aggregateRewards(syntheticLogs);
        log.info(
            {
                nTasks: sampleTasks.length,
                totalCostUsd,
                meanReward: mean,
                budgetCapUsd,
            },
            'live-eval: candidate scored'
        );
        return mean;
    };
}

// ── Per-task execution ───────────────────────────────

interface RunTaskArgs {
    readonly sendPrompt: SendPromptFn;
    readonly model: string;
    readonly maxTokens: number;
    readonly temperature: number;
    readonly perTaskTimeoutMs: number;
}

async function runOneTask(
    task: SampleTask,
    candidatePrompt: string,
    args: RunTaskArgs
): Promise<TaskOutcome> {
    const start = Date.now();
    try {
        const response = await withTimeout(
            args.sendPrompt(args.model, candidatePrompt, task.description, {
                maxTokens: args.maxTokens,
                temperature: args.temperature,
            }),
            args.perTaskTimeoutMs,
            `task ${task.id} timed out after ${args.perTaskTimeoutMs}ms`
        );

        const durationMs = Date.now() - start;
        const costUsd = response.costUsd ?? 0;
        const tokensOut = response.tokensOut ?? 0;
        const text = response.text ?? '';

        // Empty text or exact-max tokens suggests the model was truncated /
        // bailed — treat as 'escalated' (needs more budget/space) rather
        // than 'success'. This is a coarser signal than LLM-as-judge but
        // doesn't require a second AI call per eval.
        if (text.trim() === '') {
            return Object.freeze({
                taskId: task.id,
                status: 'escalated',
                costUsd,
                tokensOut,
                durationMs,
                reward: ESCALATED_REWARD,
                error: 'empty response',
            });
        }
        if (tokensOut > 0 && tokensOut >= args.maxTokens) {
            return Object.freeze({
                taskId: task.id,
                status: 'escalated',
                costUsd,
                tokensOut,
                durationMs,
                reward: ESCALATED_REWARD,
                error: 'response truncated at max tokens',
            });
        }

        const reward = deriveReward({
            id: task.id,
            taskId: task.id,
            agentName: 'live-eval',
            costUsd,
            tokensOut,
            status: 'success',
            durationMs,
            outputSummary: text.slice(0, 200),
            createdAt: new Date().toISOString(),
        });

        return Object.freeze({
            taskId: task.id,
            status: 'success',
            costUsd,
            tokensOut,
            durationMs,
            reward,
            error: null,
        });
    } catch (err) {
        const durationMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
            { taskId: task.id, err: message },
            'live-eval: task failed — scoring as failure'
        );
        return Object.freeze({
            taskId: task.id,
            status: 'failed',
            costUsd: 0,
            tokensOut: 0,
            durationMs,
            reward: FAILED_REWARD,
            error: message,
        });
    }
}

// ── Helpers ──────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, reason: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(reason)), ms);
        p.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

function toAgentLog(task: SampleTask, outcome: TaskOutcome): AgentLog {
    // Map 'skipped' → 'failed' for aggregation. The reward is already set
    // by runOneTask / skip-path; deriveReward is not consulted here.
    const status =
        outcome.status === 'skipped'
            ? 'failed'
            : (outcome.status as 'success' | 'failed' | 'escalated');
    return Object.freeze({
        id: task.id,
        taskId: task.id,
        agentName: 'live-eval',
        costUsd: outcome.costUsd,
        tokensOut: outcome.tokensOut,
        status,
        durationMs: outcome.durationMs,
        outputSummary: outcome.error ?? '',
        createdAt: new Date().toISOString(),
    });
}

function skippedLog(task: SampleTask): AgentLog {
    return Object.freeze({
        id: task.id,
        taskId: task.id,
        agentName: 'live-eval',
        costUsd: 0,
        tokensOut: 0,
        status: 'failed',
        durationMs: 0,
        outputSummary: 'budget cap reached',
        createdAt: new Date().toISOString(),
    });
}
