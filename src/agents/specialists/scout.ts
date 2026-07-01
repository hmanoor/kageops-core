/**
 * Scout — Strategist Agent
 *
 * Handles discovery, research, PRDs, planning, market analysis.
 * Primary agent for Phase 1 (Discovery) and Phase 3 (Business Viability).
 */

import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';
import { withGrounding } from '../grounding';
import { extractUrls } from '../url-extraction';
import { estimateProjectCost } from '../../orchestrator/cost-estimator';
import { getActivePresetName } from '../agent-config';

// ── Constants ────────────────────────────────────────

const SCOUT_SKILLS = [
    'market-research',
    'competitive-analysis',
    'prd-writing',
    'requirements-gathering',
    'feasibility-assessment',
    'project-planning',
    'sprint-management',
    'user-stories',
] as const;

export const SYSTEM_PROMPT =
    'You are Scout, a strategic analyst and product manager. You research thoroughly, ' +
    'write clearly, and make evidence-based recommendations. Your outputs are well-structured ' +
    'markdown documents with clear headings, data tables, and actionable conclusions.';

/** Maximum URLs to fetch per task — hard cap to prevent runaway scraping. */
const MAX_URLS_PER_TASK = 5;

/** Per-URL markdown truncation cap — keeps composite prompts bounded. */
const PER_URL_MARKDOWN_CHARS = 3000;

/** Per-URL fetch timeout — must stay well under the task timeout. */
const WEB_FETCH_TIMEOUT_MS = 15_000;

// ── Scout Agent ──────────────────────────────────────

export class Scout extends AutonautAgent {
    /** Pre-fetched web context for the current task; cleared at start of each executeTask. */
    private _webContext: string | null = null;

    constructor(modelConfig: AgentModelConfig) {
        super('scout', 'strategist', SCOUT_SKILLS, modelConfig, withGrounding(SYSTEM_PROMPT));
    }

    async executeTask(task: TaskInfo): Promise<void> {
        // Phase 2: pre-fetch any URLs referenced in the task description so
        // all handler methods receive a prompt augmented with real web context.
        this._webContext = await this.gatherWebContext(task);

        try {
            switch (task.taskType) {
                case 'concept-brief':
                    await this.writeConceptBrief(task);
                    break;
                case 'market-research':
                    await this.writeMarketResearch(task);
                    break;
                case 'feasibility-assessment':
                    await this.writeFeasibilityAssessment(task);
                    break;
                case 'prd':
                    await this.writePrd(task);
                    break;
                case 'project-plan':
                    await this.writeProjectPlan(task);
                    break;
                case 'competitive-analysis':
                    await this.writeCompetitiveAnalysis(task);
                    break;
                case 'risk-assessment':
                    await this.writeRiskAssessment(task);
                    break;
                default:
                    await this.handleGenericTask(task);
                    break;
            }
        } finally {
            this._webContext = null;
        }
    }

    /**
     * Prepend the pre-fetched "## Web context" block (if any) to an AI prompt.
     * No-op when the task description contained no URLs — zero regression.
     */
    private withWebContext(prompt: string): string {
        if (this._webContext === null) return prompt;
        return `${this._webContext}\n\n${prompt}`;
    }

    /**
     * Extract URLs from the task description, scrape each one (capped at
     * MAX_URLS_PER_TASK), and format the results as a markdown "## Web context"
     * block suitable for prepending to an AI prompt.
     *
     * Individual fetch failures are caught and logged as `web-fetch-failed`;
     * they never crash the task. If all fetches fail or no URLs are present,
     * returns null.
     */
    private async gatherWebContext(task: TaskInfo): Promise<string | null> {
        const urls = extractUrls(task.description).slice(0, MAX_URLS_PER_TASK);
        if (urls.length === 0) return null;

        const blocks: string[] = ['## Web context'];
        let successCount = 0;

        for (const url of urls) {
            try {
                const result = await this.webResearch(url, { scrape: { timeoutMs: WEB_FETCH_TIMEOUT_MS } });
                // webResearch returns ScrapeResult (no schema passed); it has a
                // `.markdown` field. Narrow defensively in case a future
                // extractor result slips through.
                const markdown =
                    'markdown' in result && typeof result.markdown === 'string'
                        ? result.markdown
                        : '';
                const truncated = markdown.slice(0, PER_URL_MARKDOWN_CHARS);
                blocks.push(`### ${url}`, truncated.length > 0 ? truncated : '_(no content)_');
                successCount += 1;
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                this.log.warn({ url, err: errorMessage }, 'web-fetch-failed');
            }
        }

        if (successCount === 0) return null;
        return blocks.join('\n\n');
    }

    private async writeConceptBrief(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Researching the idea and analyzing existing solutions...');

        const response = await this.askAI(
            this.withWebContext(
                `Write a concept brief for the following project idea.\n\n` +
                `Project: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Executive Summary\n` +
                `2. Problem Statement\n` +
                `3. Proposed Solution\n` +
                `4. Target Audience\n` +
                `5. Existing Solutions & Differentiation\n` +
                `6. Key Assumptions\n` +
                `7. Success Metrics\n` +
                `8. Initial Recommendations`,
            ),
        );

        // Append a forward-looking cost estimate sourced from local agent_logs
        // history. Always includes a disclaimer; on a first run the disclaimer
        // explicitly says "no historical data" so the user understands the
        // figures are theoretical until they have completed runs.
        const costSection = await this.buildCostEstimateSection(task);
        const fullBrief = `${response.text.trimEnd()}\n\n---\n\n${costSection}`;

        const outputPath = task.outputPath ?? 'docs/discovery/concept-brief.md';
        await this.writeFile(task.repoPath, outputPath, fullBrief);

        await this.reportProgress(task, `Concept brief written to ${outputPath}`);
    }

    /**
     * Build the "## Cost Estimate" markdown block. Pure best-effort — if the
     * estimator throws (DB unavailable, etc.), we fall back to a minimal
     * disclaimer so the brief is never blocked on cost data.
     */
    private async buildCostEstimateSection(task: TaskInfo): Promise<string> {
        try {
            const preset = getActivePresetName();
            const estimate = await estimateProjectCost({
                preset,
                projectId: task.projectId,
            });
            return estimate.markdown;
        } catch (err) {
            this.log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'Cost estimate failed — falling back to disclaimer-only block',
            );
            return [
                '## Cost Estimate',
                '',
                '> **⚠️ Estimate unavailable.** KageOps could not read historical spend data for this run.',
                '> Set a per-project budget cap on the New Project form to put a hard ceiling on spend.',
                '',
            ].join('\n');
        }
    }

    private async writeMarketResearch(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Analyzing market, competitors, and opportunities...');

        const response = await this.askAI(
            this.withWebContext(
                `Write a market research report for:\n\n` +
                `Project: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Market Overview & Size\n` +
                `2. Target Market Segments\n` +
                `3. Competitor Landscape (comparison matrix)\n` +
                `4. Market Trends\n` +
                `5. Opportunities & Threats\n` +
                `6. Entry Strategy Recommendations`,
            ),
        );

        const outputPath = task.outputPath ?? 'docs/discovery/market-research.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeFeasibilityAssessment(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Assessing technical and business feasibility...');

        // Include architecture overview if graph is available (v0.8 — null-safe)
        const archContext = await this.getCodeGraphArchitecture(task.repoPath);

        const response = await this.askAI(
            this.withWebContext(
                `Write a feasibility assessment for:\n\n` +
                `Project: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Technical Feasibility (can we build it?)\n` +
                `2. Business Feasibility (will it make money?)\n` +
                `3. Resource Requirements\n` +
                `4. Timeline Estimate\n` +
                `5. Risk Matrix (likelihood × impact)\n` +
                `6. Go/No-Go Recommendation`,
            ),
            archContext ?? undefined,
        );

        const outputPath = task.outputPath ?? 'docs/discovery/feasibility-assessment.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writePrd(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing Product Requirements Document...');

        const response = await this.askAI(
            this.withWebContext(
                `Write a Product Requirements Document (PRD) for:\n\n` +
                `Project: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Overview & Objectives\n` +
                `2. User Personas\n` +
                `3. User Stories (with acceptance criteria)\n` +
                `4. Functional Requirements\n` +
                `5. Non-Functional Requirements (performance, security, scalability)\n` +
                `6. Out of Scope\n` +
                `7. Dependencies\n` +
                `8. Success Metrics & KPIs`,
            ),
        );

        const outputPath = task.outputPath ?? 'docs/business/prd.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeProjectPlan(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Creating project plan with timeline and milestones...');

        const response = await this.askAI(
            this.withWebContext(
                `Write a project plan for:\n\n` +
                `Project: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Project Timeline (Gantt-style markdown table)\n` +
                `2. Milestones & Deliverables\n` +
                `3. Resource Allocation\n` +
                `4. Sprint Breakdown\n` +
                `5. Dependencies & Critical Path\n` +
                `6. Risk Mitigation Plan`,
            ),
        );

        const outputPath = task.outputPath ?? 'docs/business/project-plan.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeCompetitiveAnalysis(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Deep diving on competitors...');

        const response = await this.askAI(
            this.withWebContext(
                `Write a competitive analysis for:\n\n` +
                `Project: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Competitor Profiles (top 5-10)\n` +
                `2. Feature Comparison Matrix\n` +
                `3. Pricing Comparison\n` +
                `4. Strengths & Weaknesses (per competitor)\n` +
                `5. Market Positioning Map\n` +
                `6. Differentiation Strategy`,
            ),
        );

        const outputPath = task.outputPath ?? 'docs/discovery/competitive-analysis.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeRiskAssessment(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Identifying and scoring risks...');

        const response = await this.askAI(
            this.withWebContext(
                `Write a risk assessment for:\n\n` +
                `Project: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Risk Register (table: risk, category, likelihood 1-5, impact 1-5, score, mitigation)\n` +
                `2. Business Risks\n` +
                `3. Technical Risks\n` +
                `4. Operational Risks\n` +
                `5. Mitigation Strategies\n` +
                `6. Contingency Plans`,
            ),
        );

        const outputPath = task.outputPath ?? 'docs/business/risk-assessment.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async handleGenericTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, `Working on: ${task.title}...`);

        const response = await this.askAI(
            this.withWebContext(
                `Complete the following task:\n\n` +
                `Title: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Write a well-structured markdown document as your output.`,
            ),
        );

        const outputPath = task.outputPath ?? `docs/discovery/${task.taskType}.md`;
        await this.writeFile(task.repoPath, outputPath, response.text);
    }
}
