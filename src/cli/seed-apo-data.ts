/**
 * KageOps APO — Test Data Seeder
 *
 * Inserts realistic `prompt_optimizations` rows (proposed / accepted /
 * rolled_back) and `agent_logs` reward-signal rows so the APO History
 * panel and reward-from-logs can be exercised without running a real
 * beam-search overnight.
 *
 * Usage:
 *   npx tsx src/cli/seed-apo-data.ts
 *   npx tsx src/cli/seed-apo-data.ts --clear   # wipe existing rows first
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Load .env ─────────────────────────────────────────
// F-382: cross-platform; ~/.kageops/.env instead of the legacy Windows path.
const ENV_SEARCH_PATHS = [
    path.join(os.homedir(), '.kageops', '.env'),
    path.join(process.cwd(), '.env'),
];
for (const envPath of ENV_SEARCH_PATHS) {
    try {
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx === -1) continue;
                const key = trimmed.slice(0, eqIdx).trim();
                const val = trimmed.slice(eqIdx + 1).trim();
                if (process.env[key] === undefined) process.env[key] = val;
            }
            break;
        }
    } catch {
        // ignore
    }
}

import { initDatabase, query, getMany } from '../db/client';

// ── Baseline prompts (abbreviated for seed data) ─────

const SCOUT_BASELINE = `You are Scout, KageOps strategist.
Your job: research the market, size the opportunity, identify key risks.
Output concise, structured intelligence — no waffle, just signal.
Use bullet points. Always cite sources when available.`;

const SCOUT_OPTIMIZED = `You are Scout, KageOps strategic intelligence agent.
Your mission: rapid, accurate market research with measurable signal.

Core responsibilities:
- Market sizing with explicit arithmetic (TAM/SAM/SOM)
- Competitive landscape mapped to threat vectors
- Risk identification with probability and impact scores
- Buyer persona construction grounded in job-to-be-done

Output format: structured bullets, confidence tags [HIGH/MED/LOW].
Never hedge without a reason. Cite sources inline.`;

const HERALD_BASELINE = `You are Herald, KageOps marketing specialist.
Write compelling copy that converts. Be concise, clear, and action-oriented.
Match the voice to the audience (technical vs. business).`;

const HERALD_OPTIMIZED = `You are Herald, KageOps growth & marketing agent.
You write copy that moves people from awareness to action.

Copy principles:
- Lead with the benefit, not the feature
- Use active voice and short sentences (< 20 words)
- One primary CTA per piece — never dilute with options
- Technical audience: precision and specifics > enthusiasm
- Business audience: outcomes and ROI > how it works

Always ask: "What does the reader feel after reading this?"`;

const PIXEL_BASELINE = `You are Pixel, KageOps UX designer.
Design clean, functional interfaces. Describe layouts clearly.
Follow accessibility best practices and mobile-first principles.`;

const PIXEL_OPTIMIZED = `You are Pixel, KageOps product design agent.
You design interfaces that are obvious, fast, and delightful.

Design principles:
- Hierarchy first: the most important action is always the largest / boldest
- Empty states are not blank — they guide the user to their first win
- Error messages tell the user what to do, not what went wrong
- Spacing creates breathing room; density signals density of information
- Mobile-first means designing the 320px constraint before the 1440px canvas

Deliverable format: screen list → grid/layout description → copy + hierarchy notes.`;

// ── Seed data ─────────────────────────────────────────

interface OptRow {
    agentName: string;
    baselinePrompt: string;
    optimizedPrompt: string;
    baselineReward: number;
    optimizedReward: number;
    rewardDelta: number;
    beamWidth: number;
    branchFactor: number;
    rounds: number;
    nSamples: number;
    status: 'proposed' | 'accepted' | 'rolled_back';
    daysAgo: number;
    appliedDaysAgo: number | null;
}

const OPTIMIZATION_ROWS: readonly OptRow[] = [
    // Scout — accepted (oldest, good positive delta)
    {
        agentName: 'scout',
        baselinePrompt: SCOUT_BASELINE,
        optimizedPrompt: SCOUT_OPTIMIZED,
        baselineReward: 0.612,
        optimizedReward: 0.783,
        rewardDelta: 0.171,
        beamWidth: 4,
        branchFactor: 3,
        rounds: 5,
        nSamples: 6,
        status: 'accepted',
        daysAgo: 14,
        appliedDaysAgo: 13,
    },
    // Herald — rolled back (was accepted, but regressed in prod)
    {
        agentName: 'herald',
        baselinePrompt: HERALD_BASELINE,
        optimizedPrompt: HERALD_OPTIMIZED,
        baselineReward: 0.554,
        optimizedReward: 0.698,
        rewardDelta: 0.144,
        beamWidth: 4,
        branchFactor: 3,
        rounds: 5,
        nSamples: 6,
        status: 'rolled_back',
        daysAgo: 10,
        appliedDaysAgo: 9,
    },
    // Pixel — proposed (recent, pending review)
    {
        agentName: 'pixel',
        baselinePrompt: PIXEL_BASELINE,
        optimizedPrompt: PIXEL_OPTIMIZED,
        baselineReward: 0.491,
        optimizedReward: 0.623,
        rewardDelta: 0.132,
        beamWidth: 4,
        branchFactor: 3,
        rounds: 5,
        nSamples: 6,
        status: 'proposed',
        daysAgo: 2,
        appliedDaysAgo: null,
    },
    // Scout — proposed (very recent, higher delta)
    {
        agentName: 'scout',
        baselinePrompt: SCOUT_OPTIMIZED,
        optimizedPrompt: SCOUT_OPTIMIZED + '\n\nAdditionally, always surface the "so what" — the single most actionable insight for a founder making a decision today.',
        baselineReward: 0.783,
        optimizedReward: 0.841,
        rewardDelta: 0.058,
        beamWidth: 4,
        branchFactor: 4,
        rounds: 6,
        nSamples: 6,
        status: 'proposed',
        daysAgo: 1,
        appliedDaysAgo: null,
    },
    // Herald — proposed (below-average delta, still above threshold)
    {
        agentName: 'herald',
        baselinePrompt: HERALD_BASELINE,
        optimizedPrompt: HERALD_BASELINE + '\n\nAlways open with a hook — a stat, question, or bold claim — that earns the reader\'s attention in the first 5 words.',
        baselineReward: 0.554,
        optimizedReward: 0.591,
        rewardDelta: 0.037,
        beamWidth: 4,
        branchFactor: 3,
        rounds: 5,
        nSamples: 6,
        status: 'proposed',
        daysAgo: 0,
        appliedDaysAgo: null,
    },
];

// ── Agent log rows (reward signal source) ─────────────

interface LogRow {
    agentName: string;
    eventType: string;
    costUsd: number;
    tokensOut: number;
    durationMs: number;
    outputSummary: string;
    daysAgo: number;
}

function makeLogRows(): readonly LogRow[] {
    const rows: LogRow[] = [];
    const agents = ['scout', 'herald', 'pixel'] as const;

    for (const agent of agents) {
        // 8 successes, varying cost
        for (let i = 0; i < 8; i++) {
            rows.push({
                agentName: agent,
                eventType: 'task.completed',
                costUsd: 0.01 + Math.round(Math.random() * 800) / 100_000,
                tokensOut: 300 + Math.floor(Math.random() * 800),
                durationMs: 800 + Math.floor(Math.random() * 3000),
                outputSummary: `${agent} task completed successfully — sample ${i + 1}`,
                daysAgo: i + 1,
            });
        }
        // 2 failures
        for (let i = 0; i < 2; i++) {
            rows.push({
                agentName: agent,
                eventType: 'task.failed',
                costUsd: 0.005,
                tokensOut: 120,
                durationMs: 400,
                outputSummary: `${agent} task failed — sample ${i + 1}`,
                daysAgo: i + 3,
            });
        }
        // 1 escalation
        rows.push({
            agentName: agent,
            eventType: 'approval.required',
            costUsd: 0.008,
            tokensOut: 200,
            durationMs: 600,
            outputSummary: `${agent} escalated for human review`,
            daysAgo: 5,
        });
    }

    return rows;
}

// ── Main ──────────────────────────────────────────────

async function main(): Promise<void> {
    const clearFirst = process.argv.includes('--clear');

    console.log('[APO seed] Initializing database…');
    await initDatabase();

    if (clearFirst) {
        console.log('[APO seed] --clear: removing existing APO rows…');
        await query('DELETE FROM prompt_optimizations');
        await query(`DELETE FROM agent_logs WHERE agent IN ('scout','herald','pixel')`);
        console.log('[APO seed] Cleared.');
    }

    // ── Insert prompt_optimizations ──────────────────
    console.log(`[APO seed] Inserting ${OPTIMIZATION_ROWS.length} prompt_optimizations rows…`);
    for (const row of OPTIMIZATION_ROWS) {
        const createdAt = new Date(Date.now() - row.daysAgo * 86_400_000).toISOString();
        const appliedAt = row.appliedDaysAgo !== null
            ? new Date(Date.now() - row.appliedDaysAgo * 86_400_000).toISOString()
            : null;

        await query(
            `INSERT INTO prompt_optimizations (
                agent_name, baseline_prompt, optimized_prompt,
                baseline_reward, optimized_reward, reward_delta,
                beam_width, branch_factor, rounds, n_samples, status,
                created_at, applied_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
                row.agentName,
                row.baselinePrompt,
                row.optimizedPrompt,
                row.baselineReward,
                row.optimizedReward,
                row.rewardDelta,
                row.beamWidth,
                row.branchFactor,
                row.rounds,
                row.nSamples,
                row.status,
                createdAt,
                appliedAt,
            ]
        );
    }

    // ── Insert agent_logs ────────────────────────────
    const logRows = makeLogRows();
    console.log(`[APO seed] Inserting ${logRows.length} agent_logs rows…`);
    for (const row of logRows) {
        const createdAt = new Date(Date.now() - row.daysAgo * 86_400_000).toISOString();
        await query(
            `INSERT INTO agent_logs (agent, action, event_type, cost_usd, tokens_out, duration_ms, output_summary, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                row.agentName,
                `${row.agentName}.apo-seed-task`,
                row.eventType,
                row.costUsd,
                row.tokensOut,
                row.durationMs,
                row.outputSummary,
                createdAt,
            ]
        );
    }

    // ── Summary ──────────────────────────────────────
    const counts = await getMany<{ status: string; n: string }>(
        `SELECT status, COUNT(*) AS n FROM prompt_optimizations GROUP BY status ORDER BY status`
    );
    console.log('\n[APO seed] Done. prompt_optimizations counts:');
    for (const c of counts) {
        console.log(`  ${c.status}: ${c.n}`);
    }

    const logCounts = await getMany<{ agent: string; n: string }>(
        `SELECT agent, COUNT(*) AS n FROM agent_logs WHERE agent IN ('scout','herald','pixel') GROUP BY agent ORDER BY agent`
    );
    console.log('\n[APO seed] agent_logs reward rows per agent:');
    for (const c of logCounts) {
        console.log(`  ${c.agent}: ${c.n}`);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error('[APO seed] Fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
