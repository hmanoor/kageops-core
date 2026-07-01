/**
 * KageOps Speciality Matrix Manager
 *
 * Manages the living skill-score matrix for all agents.
 * Scores are updated by Sensei through benchmarks and real task outcomes.
 */

import { query, getOne, getMany } from '../db/client';

// ── Types ────────────────────────────────────────────

export interface MatrixEntry {
    readonly agent: string;
    readonly skill: string;
    readonly score: number;
    readonly benchmarkCount: number;
    readonly taskSuccessCount: number;
    readonly taskFailureCount: number;
    readonly lastBenchmarked: string | null;
}

export interface AgentScore {
    readonly agent: string;
    readonly score: number;
}

// ── Constants ────────────────────────────────────────

/** Exponential moving average weight for new observations */
const EMA_ALPHA = 0.3;

/** Minimum score (never go below) */
const MIN_SCORE = 0.0;

/** Maximum score */
const MAX_SCORE = 9.0;

// ── Speciality Matrix ────────────────────────────────

export class SpecialityMatrix {

    /**
     * Get the full matrix — all agents × all skills.
     */
    async getMatrix(): Promise<readonly MatrixEntry[]> {
        return getMany<MatrixEntry>(
            `SELECT agent, skill, score,
                    benchmark_count AS "benchmarkCount",
                    task_success_count AS "taskSuccessCount",
                    task_failure_count AS "taskFailureCount",
                    last_benchmarked AS "lastBenchmarked"
             FROM speciality_matrix
             ORDER BY agent, skill`
        );
    }

    /**
     * Get all scores for a single agent.
     */
    async getAgentScores(agent: string): Promise<readonly MatrixEntry[]> {
        return getMany<MatrixEntry>(
            `SELECT agent, skill, score,
                    benchmark_count AS "benchmarkCount",
                    task_success_count AS "taskSuccessCount",
                    task_failure_count AS "taskFailureCount",
                    last_benchmarked AS "lastBenchmarked"
             FROM speciality_matrix
             WHERE agent = $1
             ORDER BY score DESC`,
            [agent]
        );
    }

    /**
     * Get the best agent for a given skill.
     * Returns the highest-scoring agent, or null if no agents have the skill.
     */
    async getBestAgent(skill: string): Promise<AgentScore | null> {
        return getOne<AgentScore>(
            `SELECT agent, score
             FROM speciality_matrix
             WHERE skill = $1
             ORDER BY score DESC
             LIMIT 1`,
            [skill]
        );
    }

    /**
     * Get top N agents for a skill (for fallback routing).
     */
    async getTopAgents(skill: string, limit: number = 3): Promise<readonly AgentScore[]> {
        return getMany<AgentScore>(
            `SELECT agent, score
             FROM speciality_matrix
             WHERE skill = $1
             ORDER BY score DESC
             LIMIT $2`,
            [skill, limit]
        );
    }

    /**
     * Directly update a score (e.g., after a manual benchmark by Sensei).
     */
    async updateScore(agent: string, skill: string, score: number): Promise<void> {
        const clampedScore = Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));

        await query(
            `INSERT INTO speciality_matrix (agent, skill, score, benchmark_count, last_benchmarked)
             VALUES ($1, $2, $3, 1, NOW())
             ON CONFLICT (agent, skill)
             DO UPDATE SET
                score = $3,
                benchmark_count = speciality_matrix.benchmark_count + 1,
                last_benchmarked = NOW()`,
            [agent, skill, clampedScore]
        );
    }

    /**
     * Record a task outcome and adjust the score using exponential moving average.
     * success=true bumps the score up, success=false brings it down.
     */
    async recordTaskOutcome(
        agent: string,
        skill: string,
        success: boolean,
        qualityScore?: number
    ): Promise<void> {
        const current = await getOne<{ score: number }>(
            'SELECT score FROM speciality_matrix WHERE agent = $1 AND skill = $2',
            [agent, skill]
        );

        if (current === null) {
            // Agent doesn't have this skill yet — create with initial score
            const initialScore = success ? 6.0 : 3.0;
            await query(
                `INSERT INTO speciality_matrix (agent, skill, score, task_success_count, task_failure_count)
                 VALUES ($1, $2, $3, $4, $5)`,
                [agent, skill, initialScore, success ? 1 : 0, success ? 0 : 1]
            );
            return;
        }

        // Calculate new score using EMA
        // Observation value: quality score if provided, otherwise binary (9 for success, 1 for failure)
        const observation = qualityScore ?? (success ? MAX_SCORE : 1.0);
        const newScore = Math.max(
            MIN_SCORE,
            Math.min(MAX_SCORE, current.score * (1 - EMA_ALPHA) + observation * EMA_ALPHA)
        );

        const successIncrement = success ? 1 : 0;
        const failureIncrement = success ? 0 : 1;

        await query(
            `UPDATE speciality_matrix
             SET score = $1,
                 task_success_count = task_success_count + $2,
                 task_failure_count = task_failure_count + $3
             WHERE agent = $4 AND skill = $5`,
            [newScore, successIncrement, failureIncrement, agent, skill]
        );
    }

    /**
     * Find skills where no agent scores above a threshold.
     * Useful for Sensei to identify capability gaps.
     */
    async findSkillGaps(threshold: number = 4.0): Promise<readonly string[]> {
        const result = await getMany<{ skill: string }>(
            `SELECT skill
             FROM speciality_matrix
             GROUP BY skill
             HAVING MAX(score) < $1
             ORDER BY skill`,
            [threshold]
        );

        return result.map((r) => r.skill);
    }

    /**
     * Get a summary of the matrix — agent names, total skills, average scores.
     */
    async getSummary(): Promise<readonly { agent: string; skillCount: number; avgScore: number }[]> {
        return getMany<{ agent: string; skillCount: number; avgScore: number }>(
            `SELECT agent,
                    COUNT(*) AS "skillCount",
                    ROUND(AVG(score)::numeric, 1) AS "avgScore"
             FROM speciality_matrix
             GROUP BY agent
             ORDER BY "avgScore" DESC`
        );
    }
}
