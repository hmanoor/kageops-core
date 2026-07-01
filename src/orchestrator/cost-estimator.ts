/**
 * Cost Estimator
 *
 * Produces a forward-looking $USD estimate for a new project run, based on
 * historical spend in the local agent_logs table. Bias towards same-preset
 * runs (e.g. estimate for an `openrouter_budget` project should weight past
 * `openrouter_budget` runs higher than past `claude_premium` runs).
 *
 * Confidence and the user-facing disclaimer are derived from the sample
 * size — a first-time install has zero history, so we fall back to a
 * preset-class default range with a clearly-flagged "no historical data"
 * caveat. Estimates get tighter (and more useful) as the user accumulates
 * completed runs.
 *
 * Surfaced to the user through Scout's concept brief in Discovery phase.
 * Never used to gate or block a run — purely informational.
 */

import { getMany } from '../db/client';

// ── Public types ─────────────────────────────────────

export type EstimateConfidence = 'no-data' | 'low' | 'medium' | 'high';

export interface CostEstimate {
    /** Median (p50) projected spend in USD for a similar future run. */
    readonly estimatedUsd: number;
    /** Optimistic (p10) — "things go cleanly". */
    readonly p10Usd: number;
    /** Pessimistic (p90) — "agent loops a few times, retries acceptance". */
    readonly p90Usd: number;
    /** Number of completed past projects used as the data source. */
    readonly sampleSize: number;
    /** How much to trust the estimate; drives the disclaimer copy. */
    readonly confidence: EstimateConfidence;
    /** Human-readable disclaimer block (markdown — multi-line). */
    readonly disclaimer: string;
    /** Whether the estimate was preset-filtered or used the global pool. */
    readonly presetMatched: boolean;
    /** Markdown for the full "## Cost Estimate" section, ready to splice into a brief. */
    readonly markdown: string;
}

export interface EstimateOptions {
    /** Active preset name; if provided, history is filtered to same-preset runs first. */
    readonly preset?: string | null;
    /** User-set budget cap; surfaced in the disclaimer as the hard kill. */
    readonly budgetCapUsd?: number | null;
    /** When provided, the project's budget_usd is auto-fetched and used as budgetCapUsd. */
    readonly projectId?: string | null;
}

// ── Constants ────────────────────────────────────────

/**
 * Fallback ranges (low/typical/high USD) when there is no local history at all.
 * Chosen from the project's own published cost guardrails:
 *  - Subscription / local providers (claude-cli, ollama) — $0 metered, but
 *    we still surface a token-estimate-equivalent range for transparency.
 *  - Metered budget presets (openrouter_budget) — typical $0.05–$0.50 per run.
 *  - Premium API presets (claude_premium, claude-cli-premium) — $0.20–$2.00.
 */
const PRESET_FALLBACK_RANGES: Record<string, readonly [number, number, number]> = {
    'ollama': [0, 0, 0],
    'claude-cli': [0, 0, 0],
    'claude-cli-premium': [0, 0, 0],
    'openrouter_budget': [0.05, 0.20, 0.50],
    'openrouter_premium': [0.10, 0.40, 1.00],
    'claude_premium': [0.20, 0.80, 2.00],
    'gpt4_premium': [0.20, 0.80, 2.00],
};

const DEFAULT_FALLBACK: readonly [number, number, number] = [0.10, 0.40, 1.00];

const MIN_SAMPLES_LOW    = 1;
const MIN_SAMPLES_MEDIUM = 5;
const MIN_SAMPLES_HIGH   = 20;

// ── Public API ───────────────────────────────────────

export async function estimateProjectCost(opts: EstimateOptions = {}): Promise<CostEstimate> {
    const { preset } = opts;
    let budgetCapUsd: number | null = opts.budgetCapUsd ?? null;

    // Auto-fetch the project's per-run budget if a projectId is given
    if (budgetCapUsd === null && opts.projectId !== null && opts.projectId !== undefined && opts.projectId !== '') {
        try {
            const rows = await getMany<{ budget_usd: string | null }>(
                `SELECT budget_usd::text AS budget_usd FROM projects WHERE id = $1`,
                [opts.projectId],
            );
            const raw = rows[0]?.budget_usd;
            if (raw !== null && raw !== undefined && raw !== '') {
                const n = Number(raw);
                if (Number.isFinite(n) && n > 0) budgetCapUsd = n;
            }
        } catch { /* leave as null */ }
    }

    // 1. Try preset-filtered history first
    let samples: number[] = [];
    let presetMatched = false;
    if (preset !== null && preset !== undefined && preset !== '') {
        samples = await fetchCompletedProjectCosts({ preset });
        presetMatched = samples.length > 0;
    }

    // 2. Fall back to global history if preset gave us nothing
    if (samples.length === 0) {
        samples = await fetchCompletedProjectCosts({});
    }

    if (samples.length === 0) {
        return buildNoDataEstimate(preset ?? null, budgetCapUsd ?? null);
    }

    const p10 = percentile(samples, 0.10);
    const p50 = percentile(samples, 0.50);
    const p90 = percentile(samples, 0.90);
    const confidence = confidenceFromSampleSize(samples.length);

    const disclaimer = renderDisclaimer({
        confidence,
        sampleSize: samples.length,
        presetMatched,
        preset: preset ?? null,
        budgetCapUsd: budgetCapUsd ?? null,
    });

    const markdown = renderMarkdown({
        p10, p50, p90,
        confidence,
        sampleSize: samples.length,
        presetMatched,
        preset: preset ?? null,
        budgetCapUsd: budgetCapUsd ?? null,
        disclaimer,
    });

    return {
        estimatedUsd: round(p50),
        p10Usd: round(p10),
        p90Usd: round(p90),
        sampleSize: samples.length,
        confidence,
        disclaimer,
        presetMatched,
        markdown,
    };
}

// ── Internals ────────────────────────────────────────

interface FetchOpts {
    readonly preset?: string;
}

async function fetchCompletedProjectCosts(opts: FetchOpts): Promise<number[]> {
    // Sum cost_usd per project. Limit to projects that finished
    // (status = 'completed' OR phase = 'launch-growth') so we don't poison
    // the dataset with abandoned half-runs that under-represent true spend.
    const params: unknown[] = [];
    let presetClause = '';
    if (opts.preset !== undefined && opts.preset !== '') {
        params.push(opts.preset);
        presetClause = `AND p.agent_config_preset = $${params.length}`;
    }

    try {
        const rows = await getMany<{ total: string }>(
            `SELECT COALESCE(SUM(l.cost_usd), 0)::text AS total
               FROM projects p
               LEFT JOIN agent_logs l ON l.project_id = p.id
              WHERE p.status = 'completed'
                ${presetClause}
              GROUP BY p.id
              HAVING COALESCE(SUM(l.cost_usd), 0) >= 0`,
            params,
        );
        return rows.map((r) => Number(r.total)).filter((n) => Number.isFinite(n));
    } catch {
        // DB unavailable, schema mismatch, etc — degrade to no-data fallback
        return [];
    }
}

function buildNoDataEstimate(preset: string | null, budgetCapUsd: number | null): CostEstimate {
    const range = preset !== null && preset in PRESET_FALLBACK_RANGES
        ? PRESET_FALLBACK_RANGES[preset]!
        : DEFAULT_FALLBACK;
    const [low, typical, high] = range;

    const disclaimer = renderDisclaimer({
        confidence: 'no-data',
        sampleSize: 0,
        presetMatched: false,
        preset,
        budgetCapUsd,
    });

    const markdown = renderMarkdown({
        p10: low, p50: typical, p90: high,
        confidence: 'no-data',
        sampleSize: 0,
        presetMatched: false,
        preset,
        budgetCapUsd,
        disclaimer,
    });

    return {
        estimatedUsd: typical,
        p10Usd: low,
        p90Usd: high,
        sampleSize: 0,
        confidence: 'no-data',
        disclaimer,
        presetMatched: false,
        markdown,
    };
}

function confidenceFromSampleSize(n: number): EstimateConfidence {
    if (n >= MIN_SAMPLES_HIGH)   return 'high';
    if (n >= MIN_SAMPLES_MEDIUM) return 'medium';
    if (n >= MIN_SAMPLES_LOW)    return 'low';
    return 'no-data';
}

function percentile(values: readonly number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[idx]!;
}

function round(n: number): number {
    if (n === 0) return 0;
    if (n < 0.01) return Math.round(n * 10000) / 10000;
    return Math.round(n * 100) / 100;
}

function fmtUsd(n: number): string {
    if (n === 0) return '$0.00';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
}

interface DisclaimerCtx {
    readonly confidence: EstimateConfidence;
    readonly sampleSize: number;
    readonly presetMatched: boolean;
    readonly preset: string | null;
    readonly budgetCapUsd: number | null;
}

function renderDisclaimer(ctx: DisclaimerCtx): string {
    const lines: string[] = [];
    lines.push('> **⚠️ Estimate only — not a quote.**');

    switch (ctx.confidence) {
        case 'no-data':
            lines.push(
                '> This is your **first run** — KageOps has no historical spend data on this machine yet. ' +
                'The figures below come from a published preset-class default and may differ significantly from your actual cost.'
            );
            break;
        case 'low':
            lines.push(
                `> Based on **only ${ctx.sampleSize} prior completed run${ctx.sampleSize === 1 ? '' : 's'}** — accuracy is low. ` +
                'Estimates will improve once you have at least 5 runs of similar shape.'
            );
            break;
        case 'medium':
            lines.push(
                `> Based on ${ctx.sampleSize} prior completed runs — accuracy is moderate. ` +
                'After ~20 runs the estimate stabilises further.'
            );
            break;
        case 'high':
            lines.push(`> Based on ${ctx.sampleSize} prior completed runs — high confidence.`);
            break;
    }

    if (ctx.preset !== null && ctx.preset !== '') {
        lines.push(
            ctx.presetMatched
                ? `> Filtered to runs using the active preset \`${ctx.preset}\`.`
                : `> No prior runs used \`${ctx.preset}\` — estimate uses the global average across all presets.`
        );
    }

    if (ctx.budgetCapUsd !== null && ctx.budgetCapUsd > 0) {
        lines.push(
            `> Hard kill at \`KAGEOPS_MAX_RUN_USD = ${fmtUsd(ctx.budgetCapUsd)}\` — the run is cancelled before it overspends.`
        );
    } else {
        lines.push(
            '> No budget cap set on this project — set one via the New Project form or `KAGEOPS_MAX_RUN_USD` to put a hard ceiling on spend.'
        );
    }

    lines.push(
        '> The estimate excludes external costs (your AI provider may bill separately) and assumes the project completes without unusual retry loops.'
    );

    return lines.join('\n');
}

interface MarkdownCtx extends DisclaimerCtx {
    readonly p10: number;
    readonly p50: number;
    readonly p90: number;
    readonly disclaimer: string;
}

function renderMarkdown(ctx: MarkdownCtx): string {
    const presetLabel = ctx.preset !== null && ctx.preset !== '' ? ctx.preset : '(default)';
    const conf = ctx.confidence === 'no-data' ? 'No historical data' : `${ctx.confidence} (${ctx.sampleSize} runs)`;
    return [
        '## Cost Estimate',
        '',
        '| Scenario | Projected spend |',
        '| --- | --- |',
        `| Optimistic (p10) | ${fmtUsd(ctx.p10)} |`,
        `| **Typical (p50)** | **${fmtUsd(ctx.p50)}** |`,
        `| Pessimistic (p90) | ${fmtUsd(ctx.p90)} |`,
        '',
        `**Active preset:** \`${presetLabel}\`  `,
        `**Confidence:** ${conf}  `,
        ctx.budgetCapUsd !== null && ctx.budgetCapUsd > 0
            ? `**Budget cap:** ${fmtUsd(ctx.budgetCapUsd)}`
            : '**Budget cap:** (none)',
        '',
        ctx.disclaimer,
        '',
    ].join('\n');
}
