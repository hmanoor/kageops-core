/**
 * Build Summary Report
 *
 * Generates a self-contained HTML report when a project transitions to
 * `completed`. Captures the data the user actually wants to see at the
 * end of a run: how long it took, what it cost, which agents did the work,
 * what the workspace produced. Saves the report to two locations:
 *
 *   1. `<repo_path>/build-report.html` — checked-in alongside the project
 *      so it travels with the codebase (great for handover, sharing).
 *   2. `<KAGEOPS_DATA_DIR>/build-reports/<project-id>-<slug>.html` —
 *      central index so all reports are findable from one place, useful
 *      until the in-app admin portal exists (Sprint 8 / F-306).
 *
 * Wired in via `subscribeBuildSummaryGenerator()` in orchestrator-bootstrap;
 * subscribes to the `project.completed` event from EventBus. Pure
 * fire-and-forget — failures log but never affect the orchestrator.
 *
 * Visual design mirrors `docs/projects/wellbeing-almanac-build-report.html`
 * (dark theme, status bar, stats grid, sectioned blocks). The data, however,
 * comes from agent_logs / tasks / projects — purely from KageOps's own
 * runtime, not from human-authored content.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getMany, getOne } from '../db/client';
import { createLogger } from '../shared/logger';
import type { EventBus } from './event-bus';

const log = createLogger('BuildSummary');

// ── Public types ─────────────────────────────────────

export interface BuildReport {
    readonly project: {
        readonly id: string;
        readonly name: string;
        readonly description: string | null;
        /** Short 1-3 sentence summary derived from description (no full prompt dump). */
        readonly summary: string | null;
        /** Requirements extracted from description: bullet-style "must X", numbered lists, etc. */
        readonly requirements: readonly string[];
        readonly repoPath: string;
        readonly finalPhase: string;
        readonly finalStatus: string;
        readonly trustLevel: string;
        readonly preset: string | null;
        readonly startedAt: string;
        readonly completedAt: string;
        readonly durationMs: number;
        /**
         * P1-05a: which iteration cycle this report covers.
         *   - `0` (or null on pre-026 data dirs) = original build.
         *   - `1+` = a reopen cycle. Tasks decomposed during this cycle
         *     reference the iteration row directly (P1-06a).
         *
         * The full per-iteration timeline render is P1-05b; for now the
         * header just shows "Iteration N" as a badge so operators on
         * reopened projects can tell at a glance which cycle this report
         * captures.
         */
        readonly iterationIndex: number | null;
    };
    /** Detected from the produced workspace — frameworks, runtime, languages.
     *  Empty arrays / null fields when nothing is detected (e.g. static-only). */
    readonly techStack: {
        readonly runtime: string | null;
        readonly packageManager: string | null;
        readonly buildTool: string | null;
        readonly frameworks: readonly string[];
        readonly languages: ReadonlyArray<{ readonly name: string; readonly fileCount: number }>;
    };
    readonly cost: {
        readonly totalUsd: number;
        readonly budgetUsd: number | null;
        readonly totalTokensIn: number;
        readonly totalTokensOut: number;
        readonly callCount: number;
        readonly byAgent: ReadonlyArray<{
            readonly agent: string;
            readonly usd: number;
            readonly tokensIn: number;
            readonly tokensOut: number;
            readonly calls: number;
        }>;
        readonly byPhase: ReadonlyArray<{
            readonly phase: string;
            readonly usd: number;
            readonly calls: number;
        }>;
    };
    readonly tasks: {
        readonly total: number;
        readonly completed: number;
        readonly failed: number;
        readonly byAgent: ReadonlyArray<{
            readonly agent: string;
            readonly total: number;
            readonly completed: number;
            readonly failed: number;
        }>;
    };
    readonly workspace: {
        readonly fileCount: number;
        readonly totalBytes: number;
        readonly totalLines: number;
        readonly byExtension: ReadonlyArray<{
            readonly ext: string;
            readonly count: number;
            readonly bytes: number;
            readonly lines: number;
        }>;
    };
}

// ── Public API ───────────────────────────────────────

/**
 * Subscribe to `project.completed` events. Any orchestrator wiring code
 * (orchestrator-bootstrap, headless-runner) calls this once at startup.
 * Idempotent: safe to call multiple times — each call adds one subscriber.
 */
export function subscribeBuildSummaryGenerator(eventBus: EventBus): void {
    eventBus.subscribe('project.completed', async (event) => {
        const data = (event.data ?? {}) as { readonly projectId?: string };
        const projectId = data.projectId ?? event.projectId ?? null;
        if (projectId === null || projectId === undefined || projectId === '') {
            log.warn({ event }, 'project.completed event missing projectId — skipping report');
            return;
        }
        try {
            await generateAndSaveBuildReport(projectId);
        } catch (err) {
            log.error(
                { err: err instanceof Error ? err.message : String(err), projectId },
                'Build summary generation failed (continuing — non-fatal)',
            );
        }
    });
}

/**
 * Public for testability — given a projectId, produce the report and save
 * it to both target locations. Returns the absolute path of the workspace
 * report so callers (CLI, admin portal) can link to it.
 */
export async function generateAndSaveBuildReport(projectId: string): Promise<{
    readonly workspacePath: string | null;
    readonly centralPath: string;
    readonly report: BuildReport;
}> {
    const report = await collectBuildReport(projectId);
    const html = renderBuildReportHtml(report);

    const workspacePath = report.project.repoPath !== ''
        ? path.join(report.project.repoPath, 'build-report.html')
        : null;
    const centralDir  = path.join(
        process.env['KAGEOPS_DATA_DIR'] ?? path.join(os.homedir(), '.kageops'),
        'build-reports',
    );
    const centralPath = path.join(centralDir, `${slugify(report.project.name)}-${projectId}.html`);

    if (workspacePath !== null) {
        try {
            fs.mkdirSync(report.project.repoPath, { recursive: true });
            fs.writeFileSync(workspacePath, html, 'utf-8');
        } catch (err) {
            log.warn(
                { err: err instanceof Error ? err.message : String(err), workspacePath },
                'Could not write workspace build-report (continuing)',
            );
        }
    }

    try {
        fs.mkdirSync(centralDir, { recursive: true });
        fs.writeFileSync(centralPath, html, 'utf-8');
    } catch (err) {
        log.warn(
            { err: err instanceof Error ? err.message : String(err), centralPath },
            'Could not write central build-report (continuing)',
        );
    }

    log.info({ projectId, workspacePath, centralPath }, 'Build report generated');
    return { workspacePath, centralPath, report };
}

// ── DB collection ────────────────────────────────────

interface ProjectRow {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly repo_path: string;
    readonly phase: string;
    readonly status: string;
    readonly trust_level: string;
    readonly agent_config_preset: string | null;
    readonly budget_usd: string | null;
    readonly created_at: string;
    readonly updated_at: string;
}

interface CostRow {
    readonly agent: string;
    readonly model_used: string | null;
    readonly cost_usd: string;
    readonly tokens_in: string;
    readonly tokens_out: string;
    readonly calls: string;
}

interface PhaseCostRow {
    readonly phase: string;
    readonly cost_usd: string;
    readonly calls: string;
}

interface TaskRow {
    readonly assigned_agent: string;
    readonly status: string;
    readonly count: string;
}

async function collectBuildReport(projectId: string): Promise<BuildReport> {
    const project = await getOne<ProjectRow>(
        `SELECT id, name, description, repo_path, phase, status, trust_level,
                agent_config_preset, budget_usd::text AS budget_usd,
                created_at::text AS created_at, updated_at::text AS updated_at
         FROM projects WHERE id = $1`,
        [projectId],
    );
    if (project === null) {
        throw new Error(`Project ${projectId} not found in database`);
    }

    const byAgentRows = await getMany<CostRow>(
        `SELECT agent,
                MAX(model_used) AS model_used,
                COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
                COALESCE(SUM(tokens_in), 0)::text AS tokens_in,
                COALESCE(SUM(tokens_out), 0)::text AS tokens_out,
                COUNT(*)::text AS calls
         FROM agent_logs
         WHERE project_id = $1 AND action = 'ai-request'
         GROUP BY agent
         ORDER BY SUM(cost_usd) DESC NULLS LAST`,
        [projectId],
    );

    const byPhaseRows = await getMany<PhaseCostRow>(
        `SELECT COALESCE(t.phase, 'unknown') AS phase,
                COALESCE(SUM(l.cost_usd), 0)::text AS cost_usd,
                COUNT(*)::text AS calls
         FROM agent_logs l
         LEFT JOIN tasks t ON t.id = l.task_id
         WHERE l.project_id = $1 AND l.action = 'ai-request'
         GROUP BY COALESCE(t.phase, 'unknown')
         ORDER BY SUM(l.cost_usd) DESC NULLS LAST`,
        [projectId],
    );

    const taskRows = await getMany<TaskRow>(
        `SELECT COALESCE(assigned_agent, 'unassigned') AS assigned_agent,
                status,
                COUNT(*)::text AS count
         FROM tasks
         WHERE project_id = $1
         GROUP BY assigned_agent, status`,
        [projectId],
    );

    const totalCostUsd    = byAgentRows.reduce((s, r) => s + numFromText(r.cost_usd),    0);
    const totalTokensIn   = byAgentRows.reduce((s, r) => s + numFromText(r.tokens_in),   0);
    const totalTokensOut  = byAgentRows.reduce((s, r) => s + numFromText(r.tokens_out),  0);
    const totalCalls      = byAgentRows.reduce((s, r) => s + numFromText(r.calls),       0);

    const tasksByAgent = aggregateTasksByAgent(taskRows);
    const taskTotals = taskRows.reduce(
        (acc, r) => {
            const n = numFromText(r.count);
            acc.total += n;
            if (r.status === 'completed') acc.completed += n;
            if (r.status === 'failed')    acc.failed    += n;
            return acc;
        },
        { total: 0, completed: 0, failed: 0 },
    );

    const workspace = scanWorkspace(project.repo_path);
    const techStack = detectTechStack(project.repo_path, workspace);
    const { summary, requirements } = extractBrief(project.description);

    const startedAt   = project.created_at;
    const completedAt = project.updated_at;
    const durationMs  = Math.max(0, dateMs(completedAt) - dateMs(startedAt));

    // P1-05a: capture the current iteration so the report header can
    // show "Iteration N" when this is a reopen build. Best-effort
    // read — legacy pre-026 data dirs simply yield null, which the
    // renderer treats as "original build, omit badge".
    let iterationIndex: number | null = null;
    try {
        const { iterationRepository } = await import('../db/iteration-repo');
        const current = await iterationRepository.getCurrent(project.id);
        iterationIndex = current?.iterationIndex ?? null;
    } catch {
        // Best-effort; iterations table may be absent.
    }

    return {
        project: {
            id:           project.id,
            name:         project.name,
            description:  project.description,
            summary,
            requirements,
            repoPath:     project.repo_path,
            finalPhase:   project.phase,
            finalStatus:  project.status,
            trustLevel:   project.trust_level,
            preset:       project.agent_config_preset,
            startedAt,
            completedAt,
            durationMs,
            iterationIndex,
        },
        techStack,
        cost: {
            totalUsd:    totalCostUsd,
            budgetUsd:   project.budget_usd !== null && project.budget_usd !== '' ? Number(project.budget_usd) : null,
            totalTokensIn,
            totalTokensOut,
            callCount: totalCalls,
            byAgent: byAgentRows.map((r) => ({
                agent:     r.agent,
                usd:       numFromText(r.cost_usd),
                tokensIn:  numFromText(r.tokens_in),
                tokensOut: numFromText(r.tokens_out),
                calls:     numFromText(r.calls),
            })),
            byPhase: byPhaseRows.map((r) => ({
                phase: r.phase,
                usd:   numFromText(r.cost_usd),
                calls: numFromText(r.calls),
            })),
        },
        tasks: {
            total:     taskTotals.total,
            completed: taskTotals.completed,
            failed:    taskTotals.failed,
            byAgent:   tasksByAgent,
        },
        workspace,
    };
}

function aggregateTasksByAgent(rows: readonly TaskRow[]): ReadonlyArray<{
    readonly agent: string;
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
}> {
    const map = new Map<string, { total: number; completed: number; failed: number }>();
    for (const r of rows) {
        const n = numFromText(r.count);
        const cur = map.get(r.assigned_agent) ?? { total: 0, completed: 0, failed: 0 };
        cur.total += n;
        if (r.status === 'completed') cur.completed += n;
        if (r.status === 'failed')    cur.failed    += n;
        map.set(r.assigned_agent, cur);
    }
    return Array.from(map.entries())
        .map(([agent, c]) => ({ agent, ...c }))
        .sort((a, b) => b.total - a.total);
}

// ── Workspace scan ───────────────────────────────────

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.cache',
    'coverage', '.vscode', '.idea', '.kageops', '.wrangler',
]);
const TEXT_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.scss', '.md',
    '.json', '.yml', '.yaml', '.txt', '.sh', '.py', '.go', '.rs',
    '.svg', '.toml', '.xml', '.sql',
]);

function scanWorkspace(repoPath: string): BuildReport['workspace'] {
    if (repoPath === '' || !fs.existsSync(repoPath)) {
        return { fileCount: 0, totalBytes: 0, totalLines: 0, byExtension: [] };
    }
    const byExt = new Map<string, { count: number; bytes: number; lines: number }>();
    let fileCount = 0;
    let totalBytes = 0;
    let totalLines = 0;

    const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const ent of entries) {
            if (ent.name.startsWith('.') && ent.name !== '.env.example') {
                if (ent.isDirectory() && !SKIP_DIRS.has(ent.name)) {
                    // hidden directory but not in skip list — still skip
                    continue;
                }
                if (ent.isDirectory()) continue;
            }
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue;
                walk(path.join(dir, ent.name));
                continue;
            }
            if (!ent.isFile()) continue;

            const full = path.join(dir, ent.name);
            let stat: fs.Stats;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.size > 5_000_000) continue;            // skip 5MB+ files
            const ext = path.extname(ent.name).toLowerCase() || '(none)';
            let lines = 0;
            if (TEXT_EXTS.has(ext)) {
                try {
                    const buf = fs.readFileSync(full, 'utf-8');
                    lines = buf.split('\n').length;
                } catch { lines = 0; }
            }
            const cur = byExt.get(ext) ?? { count: 0, bytes: 0, lines: 0 };
            cur.count += 1;
            cur.bytes += stat.size;
            cur.lines += lines;
            byExt.set(ext, cur);
            fileCount += 1;
            totalBytes += stat.size;
            totalLines += lines;
        }
    };

    walk(repoPath);

    return {
        fileCount,
        totalBytes,
        totalLines,
        byExtension: Array.from(byExt.entries())
            .map(([ext, c]) => ({ ext, ...c }))
            .sort((a, b) => b.count - a.count),
    };
}

// ── Brief extraction ─────────────────────────────────

/**
 * Convert a raw project description (often the full prompt the user pasted)
 * into a clean Summary + Requirements pair suitable for a client-facing
 * build report. We never dump the full prompt — that's what the user
 * explicitly asked us to stop doing.
 *
 * Heuristics:
 *  - **Summary** = first 1-2 plain sentences, capped at ~220 chars.
 *    Skips headings, code fences, and bullet lines.
 *  - **Requirements** = bullet lines (`- `, `* `, `1. `), or sentences
 *    beginning with "must", "should", "need to", "the app". Capped at 8
 *    items. Anything longer than 200 chars is truncated with an ellipsis
 *    so a wall-of-text prompt doesn't blow out the report layout.
 */
export function extractBrief(description: string | null): {
    readonly summary: string | null;
    readonly requirements: readonly string[];
} {
    if (description === null || description.trim() === '') {
        return { summary: null, requirements: [] };
    }
    const lines = description.split(/\r?\n/).map((l) => l.trim());
    const requirements: string[] = [];
    const summaryCandidates: string[] = [];

    let inFence = false;
    const bulletRe   = /^(?:[-*•]|\d+[.)])\s+(.+)$/;
    const reqHeadRe  = /^(?:must|should|need(?:s)?\s+to|the\s+(?:app|user|system)\s+(?:must|should|needs|will))\b/i;

    for (const raw of lines) {
        if (raw === '') continue;
        if (/^```/.test(raw)) { inFence = !inFence; continue; }
        if (inFence) continue;
        if (/^#+\s/.test(raw)) continue;

        const bullet = bulletRe.exec(raw);
        if (bullet !== null) {
            const text = bullet[1]!.replace(/^\*\*(.*?)\*\*:?\s*/, '$1: ').trim();
            if (text !== '') requirements.push(truncate(text, 200));
            continue;
        }

        if (reqHeadRe.test(raw)) {
            requirements.push(truncate(raw.replace(/[.;]$/, ''), 200));
            continue;
        }

        summaryCandidates.push(raw);
    }

    // Build a summary from the first 1-2 prose sentences, capped at ~220 chars.
    const prose = summaryCandidates.join(' ').replace(/\s+/g, ' ').trim();
    let summary: string | null = null;
    if (prose !== '') {
        const sentences = prose.split(/(?<=[.!?])\s+/);
        let acc = '';
        for (const s of sentences) {
            const next = acc === '' ? s : `${acc} ${s}`;
            if (next.length > 220) { if (acc === '') acc = truncate(s, 220); break; }
            acc = next;
            if (acc.length > 140) break;
        }
        summary = acc !== '' ? acc : truncate(prose, 220);
    }

    return {
        summary,
        requirements: requirements.slice(0, 8),
    };
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

// ── Tech stack detection ─────────────────────────────

/**
 * Detect frameworks, runtime, package manager, build tool, and primary
 * languages from the produced workspace. Used to render the Tech Stack
 * section of the build report (client-facing — answers "what was actually
 * built with"). Best-effort only; missing data renders as "—" in the UI.
 *
 * Strategy:
 *  - Read package.json deps for frameworks (react/vue/express/next/etc.)
 *  - Sniff lockfiles for package manager (yarn/pnpm/npm)
 *  - Sniff config files for build tool (vite/webpack/turbo/etc.)
 *  - Roll up file extensions from the existing workspace scan for languages.
 */
function detectTechStack(
    repoPath: string,
    workspace: BuildReport['workspace'],
): BuildReport['techStack'] {
    if (repoPath === '' || !fs.existsSync(repoPath)) {
        return { runtime: null, packageManager: null, buildTool: null, frameworks: [], languages: [] };
    }

    let runtime: string | null = null;
    let packageManager: string | null = null;
    let buildTool: string | null = null;
    const frameworks = new Set<string>();

    const exists = (p: string): boolean => {
        try { return fs.existsSync(path.join(repoPath, p)); } catch { return false; }
    };

    // Package manager + runtime hints from lockfiles
    if (exists('package.json'))          runtime = 'Node.js';
    if (exists('package-lock.json'))     packageManager = 'npm';
    if (exists('yarn.lock'))             packageManager = 'yarn';
    if (exists('pnpm-lock.yaml'))        packageManager = 'pnpm';
    if (exists('bun.lockb'))             packageManager = 'bun';
    if (exists('requirements.txt') || exists('pyproject.toml')) runtime = runtime ?? 'Python';
    if (exists('Cargo.toml'))            runtime = runtime ?? 'Rust';
    if (exists('go.mod'))                runtime = runtime ?? 'Go';
    if (exists('Gemfile'))               runtime = runtime ?? 'Ruby';

    // Build tool hints
    if (exists('vite.config.ts') || exists('vite.config.js')) buildTool = 'Vite';
    else if (exists('webpack.config.js')) buildTool = 'webpack';
    else if (exists('next.config.js') || exists('next.config.ts') || exists('next.config.mjs')) buildTool = 'Next.js';
    else if (exists('turbo.json'))        buildTool = 'Turborepo';
    else if (exists('esbuild.config.js')) buildTool = 'esbuild';
    else if (exists('rollup.config.js'))  buildTool = 'Rollup';
    else if (exists('Makefile'))          buildTool = 'make';

    // Framework hints from package.json
    if (exists('package.json')) {
        try {
            const pkgRaw = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8');
            const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
            const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
            const has = (n: string): boolean => Object.prototype.hasOwnProperty.call(allDeps, n);

            if (has('next'))                     { frameworks.add('Next.js'); buildTool = buildTool ?? 'Next.js'; }
            if (has('react') && !has('next'))    frameworks.add('React');
            if (has('vue'))                      frameworks.add('Vue');
            if (has('svelte') || has('@sveltejs/kit')) frameworks.add('Svelte');
            if (has('@angular/core'))            frameworks.add('Angular');
            if (has('astro'))                    frameworks.add('Astro');
            if (has('solid-js'))                 frameworks.add('Solid');
            if (has('express'))                  frameworks.add('Express');
            if (has('fastify'))                  frameworks.add('Fastify');
            if (has('hono'))                     frameworks.add('Hono');
            if (has('@nestjs/core'))             frameworks.add('NestJS');
            if (has('koa'))                      frameworks.add('Koa');
            if (has('electron'))                 frameworks.add('Electron');
            if (has('tailwindcss'))              frameworks.add('Tailwind CSS');
            if (has('typescript'))               frameworks.add('TypeScript');
            if (has('prisma') || has('@prisma/client')) frameworks.add('Prisma');
            if (has('drizzle-orm'))              frameworks.add('Drizzle');
            if (has('pg'))                       frameworks.add('PostgreSQL');
            if (has('mongodb') || has('mongoose')) frameworks.add('MongoDB');
            if (has('vitest'))                   frameworks.add('Vitest');
            if (has('jest'))                     frameworks.add('Jest');
            if (has('@playwright/test'))         frameworks.add('Playwright');
        } catch {
            // package.json present but unparseable — skip framework detection
        }
    }

    if (exists('requirements.txt') || exists('pyproject.toml')) {
        try {
            const req = exists('requirements.txt')
                ? fs.readFileSync(path.join(repoPath, 'requirements.txt'), 'utf-8')
                : fs.readFileSync(path.join(repoPath, 'pyproject.toml'), 'utf-8');
            const lc = req.toLowerCase();
            if (/\bfastapi\b/.test(lc))   frameworks.add('FastAPI');
            if (/\bflask\b/.test(lc))     frameworks.add('Flask');
            if (/\bdjango\b/.test(lc))    frameworks.add('Django');
            if (/\bstreamlit\b/.test(lc)) frameworks.add('Streamlit');
        } catch { /* skip */ }
    }

    // Static-only fallback: HTML+CSS workspace with no package.json
    const htmlCount = workspace.byExtension.find((e) => e.ext === '.html')?.count ?? 0;
    if (frameworks.size === 0 && runtime === null && htmlCount > 0) {
        frameworks.add('Static HTML');
    }

    // Language rollup from file extensions
    const langMap: Record<string, string> = {
        '.ts': 'TypeScript', '.tsx': 'TypeScript',
        '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
        '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
        '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.php': 'PHP',
        '.html': 'HTML', '.css': 'CSS', '.scss': 'Sass',
        '.sql': 'SQL', '.sh': 'Shell',
    };
    const byLang = new Map<string, number>();
    for (const e of workspace.byExtension) {
        const name = langMap[e.ext];
        if (name !== undefined) byLang.set(name, (byLang.get(name) ?? 0) + e.count);
    }
    const languages = Array.from(byLang.entries())
        .map(([name, fileCount]) => ({ name, fileCount }))
        .sort((a, b) => b.fileCount - a.fileCount)
        .slice(0, 6);

    return {
        runtime,
        packageManager,
        buildTool,
        frameworks: Array.from(frameworks).sort(),
        languages,
    };
}

// ── HTML rendering ───────────────────────────────────

export function renderBuildReportHtml(report: BuildReport): string {
    const r = report;
    const dur = formatDuration(r.project.durationMs);
    const totalCost   = formatUsd(r.cost.totalUsd);
    const budget      = r.cost.budgetUsd !== null ? formatUsd(r.cost.budgetUsd) : '—';
    const passRate = r.tasks.total > 0
        ? Math.round((r.tasks.completed / r.tasks.total) * 100)
        : 0;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(r.project.name)} — KageOps Build Report</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
    --bg: #0a0a0a;
    --surface: #141414;
    --surface-raised: #1a1a1a;
    --border: rgba(255,255,255,0.08);
    --border-strong: rgba(255,255,255,0.14);
    --text: #d4d4d4;
    --text-strong: #f0f0f2;
    --text-muted: #9d9d9d;
    --text-faint: #6e6e6e;
    --moss: #5BB377;
    --amber: #e5a550;
    --red: #f14c4c;
    --blue: #5aa9ff;
    --purple: #b48cff;
}
html, body { background: var(--bg); color: var(--text); font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-size: 14px; line-height: 1.55; min-height: 100vh; -webkit-font-smoothing: antialiased; }
.container { max-width: 1080px; margin: 0 auto; padding: 48px 32px 96px; }
code { font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; color: var(--text-strong); background: var(--surface-raised); padding: 1px 6px; border-radius: 3px; border: 1px solid var(--border); }

.brand { display: flex; align-items: center; gap: 14px; margin-bottom: 32px; }
.brand-mark { width: 32px; height: 32px; flex-shrink: 0; }
.wordmark { font-family: "Space Grotesk", var(--text); font-size: 18px; font-weight: 600; letter-spacing: -0.015em; }
.wm-kage { color: var(--text-strong); }
.wm-ops  { color: var(--moss); }
.brand-divider { color: var(--text-faint); margin: 0 4px; }
.brand-section { color: var(--text-muted); font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; }

.header { padding: 24px 0 32px; border-bottom: 1px solid var(--border); margin-bottom: 32px; }
.badge { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px; background: var(--surface-raised); border: 1px solid var(--border-strong); border-radius: 999px; font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 16px; }
.badge-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--moss); box-shadow: 0 0 8px rgba(91,179,119,0.6); }
h1 { font-family: "Space Grotesk", var(--text); font-size: 40px; font-weight: 600; letter-spacing: -0.025em; line-height: 1.1; color: var(--text-strong); margin-bottom: 12px; }
.subtitle { color: var(--text-muted); font-size: 16px; max-width: 70ch; line-height: 1.55; margin-bottom: 14px; }
.meta-line { display: flex; flex-wrap: wrap; gap: 18px; color: var(--text-faint); font-size: 12px; }
.meta-line strong { color: var(--text); font-weight: 500; }

.status-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; padding: 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 32px; }
.status-item { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.green  { background: var(--moss); box-shadow: 0 0 8px rgba(91,179,119,0.4); }
.status-dot.amber  { background: var(--amber); }
.status-dot.red    { background: var(--red); }
.status-label { color: var(--text-faint); margin-right: 4px; }
.status-value { color: var(--text-strong); font-weight: 500; }

.section { margin: 40px 0; }
.section-title { font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-faint); margin-bottom: 16px; }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.stat-card { padding: 18px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; transition: border-color 120ms ease; }
.stat-card.accent { border-color: rgba(91,179,119,0.25); }
.stat-card.purple { border-color: rgba(180,140,255,0.25); }
.stat-card.amber  { border-color: rgba(229,165,80,0.25); }
.stat-card.red    { border-color: rgba(241,76,76,0.25); }
.stat-label { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-faint); margin-bottom: 8px; }
.stat-value { font-family: "Space Grotesk", monospace; font-size: 32px; font-weight: 600; letter-spacing: -0.015em; color: var(--text-strong); line-height: 1.1; margin-bottom: 4px; }
.stat-card.accent .stat-value { color: var(--moss); }
.stat-card.purple .stat-value { color: var(--purple); }
.stat-card.amber  .stat-value { color: var(--amber); }
.stat-card.red    .stat-value { color: var(--red); }
.stat-sub { font-size: 11px; color: var(--text-muted); }

table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); }
th { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--text-faint); font-weight: 500; }
td { color: var(--text); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: rgba(255,255,255,0.02); }

.brief-list { list-style: none; padding: 16px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 8px; }
.brief-list li { position: relative; padding-left: 18px; color: var(--text); font-size: 13.5px; line-height: 1.55; }
.brief-list li::before { content: ''; position: absolute; left: 0; top: 9px; width: 6px; height: 6px; border-radius: 50%; background: var(--moss); box-shadow: 0 0 6px rgba(91,179,119,0.35); }

.tech-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 14px; }
.tech-item { padding: 14px 18px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 4px; }
.tech-key { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-faint); }
.tech-val { font-size: 15px; color: var(--text-strong); font-weight: 500; }

.chip-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.chip-label { font-family: "JetBrains Mono", monospace; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-faint); margin-right: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; background: var(--surface-raised); border: 1px solid var(--border-strong); border-radius: 999px; font-size: 12px; color: var(--text-strong); }
.chip-count { font-family: "JetBrains Mono", monospace; font-size: 10.5px; color: var(--text-faint); }

.billing-note { margin-top: 10px; padding: 12px 16px; background: var(--surface); border: 1px dashed var(--border-strong); border-radius: 8px; color: var(--text-muted); font-size: 12px; line-height: 1.55; }
.billing-note strong { color: var(--text); }

footer { margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; color: var(--text-faint); font-size: 11px; }
footer a { color: var(--text-muted); text-decoration: none; }
footer a:hover { color: var(--moss); }
</style>
</head>
<body>
<div class="container">

    <div class="brand">
        <svg class="brand-mark" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 16 L34 16 L34 32 L18 32"/>
            <path d="M22 22 L30 22"/>
            <path d="M40 14 L40 44 M44 18 L48 14 M44 30 L48 26 M44 42 L48 38"/>
            <path d="M22 40 L34 40 L28 50 Z" fill="var(--moss)" stroke="none"/>
        </svg>
        <span class="wordmark"><span class="wm-kage">Kage</span><span class="wm-ops">Ops</span></span>
        <span class="brand-divider">/</span>
        <span class="brand-section">Build Report</span>
    </div>

    <div class="header">
        <div class="badge"><span class="badge-dot"></span> ${esc(r.project.finalStatus)} · ${esc(r.project.finalPhase)}${
            r.project.iterationIndex !== null && r.project.iterationIndex > 0
                ? ` · iteration ${r.project.iterationIndex}`
                : ''
        }</div>
        <h1>${esc(r.project.name)}</h1>
        ${r.project.summary !== null ? `<p class="subtitle">${esc(r.project.summary)}</p>` : ''}
        <div class="meta-line">
            <span><strong>Started:</strong> ${esc(formatDate(r.project.startedAt))}</span>
            <span><strong>Completed:</strong> ${esc(formatDate(r.project.completedAt))}</span>
            <span><strong>Duration:</strong> ${esc(dur)}</span>
            <span><strong>Trust:</strong> ${esc(r.project.trustLevel)}</span>
            ${r.project.preset !== null ? `<span><strong>Preset:</strong> <code>${esc(r.project.preset)}</code></span>` : ''}
        </div>
    </div>

    ${r.project.requirements.length > 0 ? `
    <div class="section">
        <div class="section-title">Project brief</div>
        <ul class="brief-list">
            ${r.project.requirements.map((req) => `<li>${esc(req)}</li>`).join('')}
        </ul>
    </div>` : ''}

    ${(r.techStack.runtime !== null
        || r.techStack.packageManager !== null
        || r.techStack.buildTool !== null
        || r.techStack.frameworks.length > 0
        || r.techStack.languages.length > 0) ? `
    <div class="section">
        <div class="section-title">Tech stack</div>
        <div class="tech-grid">
            <div class="tech-item"><span class="tech-key">Runtime</span><span class="tech-val">${esc(r.techStack.runtime ?? '—')}</span></div>
            <div class="tech-item"><span class="tech-key">Package manager</span><span class="tech-val">${esc(r.techStack.packageManager ?? '—')}</span></div>
            <div class="tech-item"><span class="tech-key">Build tool</span><span class="tech-val">${esc(r.techStack.buildTool ?? '—')}</span></div>
        </div>
        ${r.techStack.frameworks.length > 0 ? `
        <div class="chip-row">
            <span class="chip-label">Frameworks &amp; libraries</span>
            ${r.techStack.frameworks.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}
        </div>` : ''}
        ${r.techStack.languages.length > 0 ? `
        <div class="chip-row">
            <span class="chip-label">Languages</span>
            ${r.techStack.languages.map((l) => `<span class="chip">${esc(l.name)} <span class="chip-count">${l.fileCount}</span></span>`).join('')}
        </div>` : ''}
    </div>` : ''}

    <div class="status-bar">
        <div class="status-item"><span class="status-dot ${r.project.finalStatus === 'completed' ? 'green' : 'red'}"></span><span class="status-label">Status</span><span class="status-value">${esc(titleCase(r.project.finalStatus))}</span></div>
        <div class="status-item"><span class="status-dot green"></span><span class="status-label">Tasks</span><span class="status-value">${r.tasks.completed} / ${r.tasks.total} (${passRate}%)</span></div>
        <div class="status-item"><span class="status-dot ${r.cost.budgetUsd !== null && r.cost.totalUsd > r.cost.budgetUsd ? 'red' : 'green'}"></span><span class="status-label">Spend</span><span class="status-value">${esc(totalCost)} / ${esc(budget)}</span></div>
        <div class="status-item"><span class="status-dot green"></span><span class="status-label">Files</span><span class="status-value">${r.workspace.fileCount}</span></div>
    </div>

    <div class="section">
        <div class="section-title">Cost base · billable to client</div>
        <div class="stats-grid">
            <div class="stat-card accent">
                <div class="stat-label">Project Cost Base</div>
                <div class="stat-value">${esc(totalCost)}</div>
                <div class="stat-sub">${r.cost.callCount} AI calls${r.cost.budgetUsd !== null ? ` · cap ${esc(budget)}` : ''}</div>
            </div>
            <div class="stat-card purple">
                <div class="stat-label">Tokens In</div>
                <div class="stat-value">${formatTokens(r.cost.totalTokensIn)}</div>
                <div class="stat-sub">prompt + system context</div>
            </div>
            <div class="stat-card purple">
                <div class="stat-label">Tokens Out</div>
                <div class="stat-value">${formatTokens(r.cost.totalTokensOut)}</div>
                <div class="stat-sub">model responses</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Run Time</div>
                <div class="stat-value">${esc(dur)}</div>
                <div class="stat-sub">start → completion</div>
            </div>
        </div>
        <div class="billing-note">
            <strong>Cost base only.</strong> This is what KageOps spent on AI provider calls to deliver this project — your raw cost-of-goods. Apply your own markup, hourly rate, or fixed-fee on top when invoicing the client. The per-agent and per-phase breakdowns below are the audit trail.
        </div>
    </div>

    ${r.cost.byAgent.length > 0 ? `
    <div class="section">
        <div class="section-title">By agent</div>
        <table>
            <thead><tr><th>Agent</th><th class="num">Calls</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Spend</th></tr></thead>
            <tbody>
                ${r.cost.byAgent.map((a) => `
                <tr>
                    <td><strong>${esc(titleCase(a.agent))}</strong></td>
                    <td class="num">${a.calls}</td>
                    <td class="num">${formatTokens(a.tokensIn)}</td>
                    <td class="num">${formatTokens(a.tokensOut)}</td>
                    <td class="num">${esc(formatUsd(a.usd))}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>` : ''}

    ${r.cost.byPhase.length > 0 ? `
    <div class="section">
        <div class="section-title">By phase</div>
        <table>
            <thead><tr><th>Phase</th><th class="num">Calls</th><th class="num">Spend</th></tr></thead>
            <tbody>
                ${r.cost.byPhase.map((p) => `
                <tr>
                    <td><strong>${esc(titleCase(p.phase))}</strong></td>
                    <td class="num">${p.calls}</td>
                    <td class="num">${esc(formatUsd(p.usd))}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>` : ''}

    ${r.tasks.byAgent.length > 0 ? `
    <div class="section">
        <div class="section-title">Tasks by agent</div>
        <table>
            <thead><tr><th>Agent</th><th class="num">Total</th><th class="num">Completed</th><th class="num">Failed</th><th class="num">Pass rate</th></tr></thead>
            <tbody>
                ${r.tasks.byAgent.map((t) => {
                    const pct = t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0;
                    return `
                <tr>
                    <td><strong>${esc(titleCase(t.agent))}</strong></td>
                    <td class="num">${t.total}</td>
                    <td class="num">${t.completed}</td>
                    <td class="num">${t.failed}</td>
                    <td class="num">${pct}%</td>
                </tr>`;
                }).join('')}
            </tbody>
        </table>
    </div>` : ''}

    ${r.workspace.fileCount > 0 ? `
    <div class="section">
        <div class="section-title">Workspace artifacts</div>
        <div class="stats-grid">
            <div class="stat-card accent">
                <div class="stat-label">Files</div>
                <div class="stat-value">${r.workspace.fileCount}</div>
                <div class="stat-sub">${formatBytes(r.workspace.totalBytes)} total</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Lines of Text</div>
                <div class="stat-value">${formatNumber(r.workspace.totalLines)}</div>
                <div class="stat-sub">across recognised text formats</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">File Types</div>
                <div class="stat-value">${r.workspace.byExtension.length}</div>
                <div class="stat-sub">unique extensions</div>
            </div>
        </div>
        <table style="margin-top:16px;">
            <thead><tr><th>Extension</th><th class="num">Files</th><th class="num">Lines</th><th class="num">Bytes</th></tr></thead>
            <tbody>
                ${r.workspace.byExtension.slice(0, 12).map((e) => `
                <tr>
                    <td><code>${esc(e.ext)}</code></td>
                    <td class="num">${e.count}</td>
                    <td class="num">${formatNumber(e.lines)}</td>
                    <td class="num">${formatBytes(e.bytes)}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    </div>` : ''}

    <footer>
        <span>Project ID <code>${esc(r.project.id)}</code></span>
        <span>Generated by KageOps · <a href="https://kageops.ai">kageops.ai</a></span>
    </footer>
</div>
</body>
</html>`;
}

// ── Utilities ────────────────────────────────────────

function esc(s: unknown): string {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
}

function numFromText(v: string | null | undefined): number {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function dateMs(s: string): number {
    const d = new Date(s);
    const t = d.getTime();
    return Number.isFinite(t) ? t : 0;
}

function formatUsd(usd: number): string {
    if (usd === 0) return '$0.00';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
    if (n < 1_000) return String(n);
    if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function formatNumber(n: number): string {
    return n.toLocaleString('en-US');
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

function formatDate(iso: string): string {
    try {
        const d = new Date(iso);
        if (!Number.isFinite(d.getTime())) return iso;
        return d.toLocaleString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch { return iso; }
}

function titleCase(s: string): string {
    return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
