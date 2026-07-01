/**
 * Pixel — Designer Agent
 *
 * Handles wireframes, mockups, design systems, user flows,
 * accessibility reviews, and responsive design specs.
 * Primary agent for Phase 4 (Design & Planning).
 */

import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';
import { withGrounding } from '../grounding';
import {
    DesignBrief,
    buildDesignBriefPrompt,
    buildEnhancedDesignPrompt,
    parseDesignBrief,
} from '../design-brief';
import { ProviderRegistry } from '../design/provider-registry';
import {
    DesignProviderId,
    DesignSpec,
    DesignArtifactKind,
    DEFAULT_DESIGN_PROVIDER,
} from '../design/design-provider';

// ── Constants ────────────────────────────────────────

const PIXEL_SKILLS = [
    'ui-ux-design',
    'wireframing',
    'mockup-creation',
    'design-systems',
    'user-flows',
    'accessibility',
    'responsive-design',
    'prototyping',
    'ui-build',
] as const;

export const SYSTEM_PROMPT =
    'You are Pixel, a UX designer and visual architect. You think in user flows, wireframes, ' +
    'and design systems. You create clear, accessible designs that balance aesthetics with usability. ' +
    'Your outputs are detailed markdown documents with ASCII wireframes, component specs, and style guides.';

// ── Pixel Agent ──────────────────────────────────────

export interface PixelOptions {
    /** Optional — when present, `ui-build` tasks route through the registry. */
    readonly registry?: ProviderRegistry;
    /** Which provider to request from the registry. Defaults to DEFAULT_DESIGN_PROVIDER. */
    readonly providerId?: DesignProviderId;
}

export class Pixel extends AutonautAgent {
    private readonly registry?: ProviderRegistry;
    private readonly providerId: DesignProviderId;

    constructor(modelConfig: AgentModelConfig, options: PixelOptions = {}) {
        super('pixel', 'designer', PIXEL_SKILLS, modelConfig, withGrounding(SYSTEM_PROMPT));
        this.registry = options.registry;
        this.providerId = options.providerId ?? DEFAULT_DESIGN_PROVIDER;
    }

    async executeTask(task: TaskInfo): Promise<void> {
        switch (task.taskType) {
            case 'wireframe':
                await this.writeWireframe(task);
                break;
            case 'mockup':
                await this.writeMockup(task);
                break;
            case 'design-system':
                await this.writeDesignSystem(task);
                break;
            case 'user-flow':
                await this.writeUserFlow(task);
                break;
            case 'ui-review':
                await this.writeUiReview(task);
                break;
            case 'responsive-design':
                await this.writeResponsiveDesign(task);
                break;
            case 'design-brief':
                await this.writeDesignBriefOnly(task);
                break;
            case 'ui-build':
                await this.buildUi(task);
                break;
            default:
                await this.handleGenericTask(task);
                break;
        }
    }

    /**
     * Delegate a UI-build task to the design provider stack. Produces
     * real UI files (HTML/React) instead of the markdown specs the other
     * Pixel task types emit. No-ops with a warning when no registry is
     * injected — existing wireframe/mockup tasks remain the right path
     * in that mode.
     */
    private async buildUi(task: TaskInfo): Promise<void> {
        if (this.registry === undefined) {
            await this.reportProgress(
                task,
                'ui-build skipped: no design provider registry configured for Pixel — falling back to mockup spec'
            );
            await this.writeMockup(task);
            return;
        }

        await this.reportProgress(task, 'Generating UI via design provider...');
        const brief = await this.generateDesignBrief(task);

        const outputKind: DesignArtifactKind = 'html';
        const spec: DesignSpec = {
            projectId: task.projectId,
            title: task.title,
            description: task.description,
            outputKind,
            brief: buildEnhancedDesignPrompt(brief, ''),
        };

        const provider = this.registry.resolve(this.providerId);
        const estimate = await provider.estimateCost(spec);
        await this.registry.assertCostOk(provider, estimate);

        const artifact = await provider.generateUI(spec);

        // Route provider cost into agent_logs so budget-kill sees it.
        // Without this, the provider spend is invisible and a runaway
        // design call could silently blow past KAGEOPS_MAX_RUN_USD.
        await this.logExternalCost({
            provider: artifact.provider,
            costUsd: artifact.costUsd,
            tokensIn: artifact.tokensIn,
            tokensOut: artifact.tokensOut,
            durationMs: artifact.durationMs,
            action: 'ui-build',
        });

        for (const file of artifact.files) {
            await this.writeFile(task.repoPath, file.path, file.content);
        }
        await this.reportProgress(
            task,
            `ui-build: wrote ${artifact.files.length} file(s) via ${artifact.provider} ($${artifact.costUsd.toFixed(4)})`
        );
    }

    private async generateDesignBrief(task: TaskInfo): Promise<DesignBrief> {
        const briefPrompt = buildDesignBriefPrompt(task.title, task.description);
        const briefResponse = await this.askAI(briefPrompt);
        const brief = parseDesignBrief(briefResponse.text);
        await this.reportProgress(task, 'Design brief generated');
        return brief;
    }

    private async writeDesignBriefOnly(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Generating design brief...');
        const brief = await this.generateDesignBrief(task);

        const content =
            `# Design Brief: ${task.title}\n\n` +
            `**Purpose:** ${brief.purpose}\n\n` +
            `**Audience:** ${brief.audience}\n\n` +
            `**Aesthetic:** ${brief.aesthetic}\n\n` +
            `**Constraints:** ${brief.constraints.join(', ') || 'None'}\n\n` +
            `**Anti-Patterns:** ${brief.antiPatterns.join(', ') || 'None'}\n\n` +
            `**Inspirations:** ${brief.inspirations.join(', ') || 'None'}\n`;

        const outputPath = task.outputPath ?? 'designs/design-brief.md';
        await this.writeFile(task.repoPath, outputPath, content);
        await this.reportProgress(task, `Design brief written to ${outputPath}`);
    }

    private async writeWireframe(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Sketching wireframe layouts...');

        const brief = await this.generateDesignBrief(task);

        const rawPrompt =
            `Create a text-based wireframe for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Page Layout (ASCII art wireframe)\n` +
            `2. Component Hierarchy\n` +
            `3. Navigation Structure\n` +
            `4. Key Interactions (click targets, hover states)\n` +
            `5. Content Zones (header, body, sidebar, footer)\n` +
            `6. Mobile vs Desktop Layout Notes`;

        const response = await this.askAI(buildEnhancedDesignPrompt(brief, rawPrompt));

        const outputPath = task.outputPath ?? 'designs/wireframes/wireframe.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
        await this.reportProgress(task, `Wireframe written to ${outputPath}`);
    }

    private async writeMockup(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Creating detailed mockup specifications...');

        const brief = await this.generateDesignBrief(task);

        const rawPrompt =
            `Create a detailed visual design mockup spec for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Color Palette (hex values, usage guidelines)\n` +
            `2. Typography (font families, sizes, weights, line heights)\n` +
            `3. Spacing System (margins, padding, grid)\n` +
            `4. Component Specs (buttons, inputs, cards, modals)\n` +
            `5. Iconography Style\n` +
            `6. Visual Hierarchy Rules\n` +
            `7. Dark/Light Theme Tokens`;

        const response = await this.askAI(buildEnhancedDesignPrompt(brief, rawPrompt));

        const outputPath = task.outputPath ?? 'designs/mockups/mockup.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeDesignSystem(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Building design system documentation...');

        const brief = await this.generateDesignBrief(task);

        const rawPrompt =
            `Create a design system / component library spec for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Design Tokens (colors, spacing, typography, shadows)\n` +
            `2. Component Catalog (name, variants, props, usage)\n` +
            `3. Layout Patterns (grid system, flex patterns)\n` +
            `4. Accessibility Guidelines (ARIA, color contrast, keyboard nav)\n` +
            `5. Animation & Transition Standards\n` +
            `6. Naming Conventions`;

        const response = await this.askAI(buildEnhancedDesignPrompt(brief, rawPrompt));

        const outputPath = task.outputPath ?? 'designs/design-system.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeUserFlow(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Mapping user journey and decision trees...');

        const response = await this.askAI(
            `Create a user flow / journey map for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Primary User Flow (step-by-step with decision points)\n` +
            `2. Secondary Flows (edge cases, error states)\n` +
            `3. User Personas & Goals\n` +
            `4. Screen-to-Screen Navigation Map\n` +
            `5. Interaction Points (CTA, forms, feedback)\n` +
            `6. Drop-off Risk Analysis`
        );

        const outputPath = task.outputPath ?? 'designs/user-flows/user-flow.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeUiReview(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Reviewing UI for usability and accessibility...');

        const response = await this.askAI(
            `Perform a UI/UX review for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Review:\n` +
            `1. Usability (ease of use, learnability, efficiency)\n` +
            `2. Accessibility (WCAG 2.1 compliance, screen reader, keyboard)\n` +
            `3. Consistency (patterns, terminology, visual language)\n` +
            `4. Responsive Behavior (breakpoints, touch targets)\n` +
            `5. Error Handling (error states, validation feedback)\n` +
            `6. Recommendations (prioritized by impact)`
        );

        const outputPath = task.outputPath ?? 'designs/ui-review.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeResponsiveDesign(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Defining responsive layout breakpoints...');

        const response = await this.askAI(
            `Create responsive design specifications for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Breakpoint Definitions (mobile, tablet, desktop, wide)\n` +
            `2. Layout Adaptations Per Breakpoint\n` +
            `3. Component Behavior Changes\n` +
            `4. Navigation Pattern Changes\n` +
            `5. Image/Media Handling Strategy\n` +
            `6. Touch vs Pointer Interaction Differences`
        );

        const outputPath = task.outputPath ?? 'designs/responsive-design.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async handleGenericTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, `Designing: ${task.title}...`);

        const response = await this.askAI(
            `Complete the following design task:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Write a well-structured markdown document as your output.`
        );

        const outputPath = task.outputPath ?? `designs/${task.taskType}.md`;
        await this.writeFile(task.repoPath, outputPath, response.text);
    }
}
