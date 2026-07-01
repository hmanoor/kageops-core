/**
 * KageOps Learning — Shared Types
 *
 * APO (Automatic Prompt Optimization, agent-lightning-inspired) — Phase 4
 * first iteration. All types are `readonly` to match the immutability rules
 * in CLAUDE.md.
 *
 * APO mines `agent_logs` for reward signals, mutates an agent's system prompt
 * via an LLM, then selects the best candidate via beam search. Scope in this
 * iteration: Scout, Herald, Pixel only (deterministic-quality criteria).
 */

// ── Agent log row (reward-shaped projection) ─────────

/**
 * Projection of `agent_logs` rows used as reward signal input.
 *
 * `status` is a derived, normalized label:
 *   - 'success'   → event_type === 'task.completed'
 *   - 'failed'    → event_type === 'task.failed'
 *   - 'escalated' → event_type === 'approval.required' (or similar escalation)
 *   - 'unknown'   → anything else (filtered out by `fetchAgentLogs`)
 *
 * This keeps the reward function decoupled from the raw event_type vocabulary.
 */
export type AgentLogStatus = 'success' | 'failed' | 'escalated' | 'unknown';

export interface AgentLog {
    readonly id: string;
    readonly taskId: string | null;
    readonly agentName: string;
    readonly costUsd: number;
    readonly tokensOut: number;
    readonly status: AgentLogStatus;
    readonly durationMs: number;
    readonly outputSummary: string;
    readonly createdAt: string;
}

/** Aggregate stats over a batch of reward-bearing logs. */
export interface RewardAggregate {
    readonly mean: number;
    readonly n: number;
    readonly p50: number;
}

// ── Beam-search candidate + round ────────────────────

/**
 * A single prompt candidate inside a beam-search round.
 * `parentId` lets history render the mutation tree.
 */
export interface Candidate {
    readonly id: string;
    readonly prompt: string;
    readonly reward: number;
    readonly parentId: string | null;
    readonly round: number;
}

/** Snapshot of one beam-search round. */
export interface Round {
    readonly round: number;
    readonly candidates: readonly Candidate[];
    /** Best reward seen in this round (after pruning to `beamWidth`). */
    readonly bestReward: number;
}

// ── Optimization result ──────────────────────────────

/**
 * Top-level output of `apo-engine.optimize()`.
 * `history` is ordered oldest-first; `history[0]` is the baseline seed.
 */
export interface OptimizationResult {
    readonly agentName: string;
    readonly baselinePrompt: string;
    readonly baselineReward: number;
    readonly winner: string;
    readonly winnerReward: number;
    readonly delta: number;
    readonly rounds: number;
    readonly beamWidth: number;
    readonly branchFactor: number;
    readonly history: readonly Round[];
}

// ── Persisted row (prompt_optimizations) ─────────────

export type PromptOptimizationStatus = 'proposed' | 'accepted' | 'rolled_back';

export interface PromptOptimizationRecord {
    readonly id: string;
    readonly agentName: string;
    readonly baselinePrompt: string;
    readonly optimizedPrompt: string;
    readonly baselineReward: number;
    readonly optimizedReward: number;
    readonly rewardDelta: number;
    readonly beamWidth: number;
    readonly branchFactor: number;
    readonly rounds: number;
    readonly nSamples: number;
    readonly status: PromptOptimizationStatus;
    readonly createdAt: string;
    readonly appliedAt: string | null;
}

// ── Scope ────────────────────────────────────────────

/**
 * Agents APO is allowed to touch in this iteration.
 * Deterministic-quality criteria — other agents produce artifacts whose
 * reward signal is too noisy for the current formula.
 */
export const APO_ELIGIBLE_AGENTS: readonly string[] = Object.freeze([
    'scout',
    'herald',
    'pixel',
]);
