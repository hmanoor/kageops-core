/**
 * Herald — Marketer Agent
 *
 * Handles go-to-market strategy, marketing copy, launch messaging,
 * email campaigns, social media content, pricing, and customer messaging.
 * Primary agent for Phase 3 (Business Viability) and Phase 6 (Launch & Growth).
 */

import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';
import { withGrounding } from '../grounding';
import { extractUrls } from '../url-extraction';

// ── Constants ────────────────────────────────────────

const HERALD_SKILLS = [
    'marketing-copy',
    'go-to-market',
    'product-messaging',
    'content-strategy',
    'social-media',
    'customer-research',
    'pricing-strategy',
    'retention-marketing',
] as const;

export const SYSTEM_PROMPT =
    'You are Herald, a marketing strategist and communications expert. You craft compelling ' +
    'narratives, build go-to-market strategies, and create content that resonates with target ' +
    'audiences. Your outputs are polished markdown documents with clear messaging frameworks, ' +
    'actionable recommendations, and audience-appropriate language.';

/** Maximum URLs to fetch per task — hard cap to prevent runaway scraping. */
const MAX_URLS_PER_TASK = 5;

/** Per-URL markdown truncation cap — keeps composite prompts bounded. */
const PER_URL_MARKDOWN_CHARS = 3000;

/** Per-URL fetch timeout — must stay well under the task timeout. */
const WEB_FETCH_TIMEOUT_MS = 15_000;

// ── Herald Agent ─────────────────────────────────────

export class Herald extends AutonautAgent {
    /** Pre-fetched web context for the current task; cleared at start of each executeTask. */
    private _webContext: string | null = null;

    constructor(modelConfig: AgentModelConfig) {
        super('herald', 'marketer', HERALD_SKILLS, modelConfig, withGrounding(SYSTEM_PROMPT));
    }

    async executeTask(task: TaskInfo): Promise<void> {
        // Phase 2: pre-fetch any URLs referenced in the task description so
        // all handler methods receive a prompt augmented with real web context.
        this._webContext = await this.gatherWebContext(task);

        try {
            switch (task.taskType) {
                case 'go-to-market-strategy':
                    await this.writeGoToMarketStrategy(task);
                    break;
                case 'launch-messaging':
                    await this.writeLaunchMessaging(task);
                    break;
                case 'product-copy':
                    await this.writeProductCopy(task);
                    break;
                case 'email-campaign':
                    await this.writeEmailCampaign(task);
                    break;
                case 'social-media-content':
                    await this.writeSocialMediaContent(task);
                    break;
                case 'pricing-strategy':
                    await this.writePricingStrategy(task);
                    break;
                case 'customer-messaging':
                    await this.writeCustomerMessaging(task);
                    break;
                case 'retention-strategy':
                    await this.writeRetentionStrategy(task);
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

    private async writeGoToMarketStrategy(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Developing go-to-market strategy...');

        const response = await this.askAI(
            this.withWebContext(
                `Create a go-to-market strategy for the following product.\n\n` +
                `Product: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Executive Summary\n` +
                `2. Target Market & Customer Segments\n` +
                `3. Value Proposition & Positioning\n` +
                `4. Competitive Differentiation\n` +
                `5. Channel Strategy (acquisition, distribution)\n` +
                `6. Launch Timeline & Milestones\n` +
                `7. Budget Allocation\n` +
                `8. Success Metrics & KPIs`,
            ),
        );

        const outputPath = task.outputPath ?? 'marketing/go-to-market-strategy.md';
        await this.writeFile(task.repoPath, outputPath, response.text);

        await this.reportProgress(task, `GTM strategy written to ${outputPath}`);
    }

    private async writeLaunchMessaging(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Crafting launch messaging framework...');

        const response = await this.askAI(
            this.withWebContext(
                `Create a launch messaging framework for:\n\n` +
                `Product: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Core Message (one-liner)\n` +
                `2. Elevator Pitch (30 seconds)\n` +
                `3. Key Messages (3-5 pillars)\n` +
                `4. Audience-Specific Messaging (per segment)\n` +
                `5. Press Release Draft\n` +
                `6. Launch Announcement Templates (email, social, blog)\n` +
                `7. FAQ / Objection Handling`,
            ),
        );

        const outputPath = task.outputPath ?? 'marketing/launch-messaging.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeProductCopy(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing product copy and descriptions...');

        const response = await this.askAI(
            this.withWebContext(
                `Write product copy for:\n\n` +
                `Product: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Tagline Options (3-5 variants)\n` +
                `2. Landing Page Hero Copy\n` +
                `3. Feature Descriptions (benefit-focused)\n` +
                `4. Use Case Scenarios\n` +
                `5. Testimonial/Social Proof Templates\n` +
                `6. CTA Variants\n` +
                `7. SEO Meta Description`,
            ),
        );

        const outputPath = task.outputPath ?? 'marketing/product-copy.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeEmailCampaign(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Designing email campaign sequence...');

        const response = await this.askAI(
            this.withWebContext(
                `Design an email campaign for:\n\n` +
                `Product: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Campaign Goal & Audience\n` +
                `2. Email Sequence (5-7 emails with timing)\n` +
                `3. Subject Lines (A/B variants per email)\n` +
                `4. Email Body Copy (full text for each email)\n` +
                `5. CTAs per Email\n` +
                `6. Segmentation Strategy\n` +
                `7. Expected Metrics (open rate, CTR targets)`,
            ),
        );

        const outputPath = task.outputPath ?? 'marketing/email-campaign.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeSocialMediaContent(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Creating social media content plan...');

        const response = await this.askAI(
            this.withWebContext(
                `Create a social media content plan for:\n\n` +
                `Product: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Platform Strategy (which platforms, why)\n` +
                `2. Content Calendar (2 weeks of posts)\n` +
                `3. Post Templates per Platform (Twitter/X, LinkedIn, Reddit)\n` +
                `4. Hashtag Strategy\n` +
                `5. Community Engagement Playbook\n` +
                `6. Thread/Series Ideas\n` +
                `7. Influencer/Partnership Opportunities`,
            ),
        );

        const outputPath = task.outputPath ?? 'marketing/social-media-content.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writePricingStrategy(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Analyzing pricing models and strategy...');

        const response = await this.askAI(
            this.withWebContext(
                `Develop a pricing strategy for:\n\n` +
                `Product: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Pricing Model Options (freemium, subscription, usage-based, etc.)\n` +
                `2. Recommended Model & Rationale\n` +
                `3. Tier Design (features per tier, naming)\n` +
                `4. Price Points & Anchoring\n` +
                `5. Competitive Pricing Comparison\n` +
                `6. Discount & Promotion Strategy\n` +
                `7. Revenue Projections (3 scenarios)\n` +
                `8. Price Sensitivity Considerations`,
            ),
        );

        const outputPath = task.outputPath ?? 'marketing/pricing-strategy.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeCustomerMessaging(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Building customer messaging framework...');

        const response = await this.askAI(
            this.withWebContext(
                `Create a customer messaging framework for:\n\n` +
                `Product: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Customer Personas (2-4 detailed personas)\n` +
                `2. Pain Points per Persona\n` +
                `3. Value Messages per Persona\n` +
                `4. Onboarding Welcome Sequence\n` +
                `5. In-App Messaging Templates\n` +
                `6. Support Response Templates\n` +
                `7. Feedback Request Templates`,
            ),
        );

        const outputPath = task.outputPath ?? 'marketing/customer-messaging.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeRetentionStrategy(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Designing retention and growth strategy...');

        const response = await this.askAI(
            this.withWebContext(
                `Design a retention and growth strategy for:\n\n` +
                `Product: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Include:\n` +
                `1. Retention Framework (engagement loops)\n` +
                `2. Churn Risk Indicators\n` +
                `3. Re-engagement Campaign (email + in-app)\n` +
                `4. Loyalty/Referral Program Design\n` +
                `5. Feature Adoption Strategy\n` +
                `6. NPS/CSAT Measurement Plan\n` +
                `7. Growth Levers & Experiments`,
            ),
        );

        const outputPath = task.outputPath ?? 'marketing/retention-strategy.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async handleGenericTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, `Working on: ${task.title}...`);

        const response = await this.askAI(
            this.withWebContext(
                `Complete the following marketing task:\n\n` +
                `Title: ${task.title}\n` +
                `Description: ${task.description}\n\n` +
                `Write a well-structured markdown document with actionable marketing recommendations.`,
            ),
        );

        const outputPath = task.outputPath ?? `marketing/${task.taskType}.md`;
        await this.writeFile(task.repoPath, outputPath, response.text);
    }
}
