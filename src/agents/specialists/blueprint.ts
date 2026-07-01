/**
 * Blueprint — Architect Agent
 *
 * Handles system design, tech decisions, API design, database design,
 * architecture reviews, and ADRs.
 */

import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';
import {
    TaskSpec,
    buildDecompositionPrompt,
    parseTaskSpecs,
    validateTaskSpecs,
} from '../task-spec-format';

// ── Constants ────────────────────────────────────────

const BLUEPRINT_SKILLS = [
    'system-design',
    'tech-stack-selection',
    'api-design',
    'database-design',
    'infrastructure-planning',
    'architecture-review',
    'tradeoff-analysis',
    'scalability-planning',
] as const;

const SYSTEM_PROMPT =
    'You are Blueprint, a systems architect. You design scalable, maintainable systems. ' +
    'You think in tradeoffs and always document your decisions with ADRs. ' +
    'Your outputs include mermaid diagrams, clear component descriptions, and reasoned tech choices.';

// ── Blueprint Agent ──────────────────────────────────

export class Blueprint extends AutonautAgent {
    constructor(modelConfig: AgentModelConfig) {
        super('blueprint', 'architect', BLUEPRINT_SKILLS, modelConfig, SYSTEM_PROMPT);
    }

    async executeTask(task: TaskInfo): Promise<void> {
        switch (task.taskType) {
            case 'architecture':
                await this.designArchitecture(task);
                break;
            case 'decompose':
                await this.decomposeIntoTasks(task);
                break;
            case 'tech-stack':
                await this.evaluateTechStack(task);
                break;
            case 'api-design':
                await this.designApi(task);
                break;
            case 'database-design':
                await this.designDatabase(task);
                break;
            case 'architecture-review':
                await this.reviewArchitecture(task);
                break;
            case 'adr':
                await this.writeAdr(task);
                break;
            default:
                await this.handleGenericTask(task);
                break;
        }
    }

    private async designArchitecture(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Designing system architecture...');

        const response = await this.askAI(
            `Design the system architecture for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Architecture Overview (with mermaid diagram)\n` +
            `2. Component Breakdown\n` +
            `3. Data Flow\n` +
            `4. Technology Stack Justification\n` +
            `5. Scalability Considerations\n` +
            `6. Security Architecture\n` +
            `7. Deployment Architecture (mermaid diagram)\n` +
            `8. Key Design Decisions (brief ADR format)`
        );

        const outputPath = task.outputPath ?? 'docs/design/architecture.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async evaluateTechStack(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Evaluating tech stack options...');

        const response = await this.askAI(
            `Evaluate and recommend a tech stack for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Frontend Options (comparison matrix)\n` +
            `2. Backend Options (comparison matrix)\n` +
            `3. Database Options\n` +
            `4. Infrastructure/Cloud\n` +
            `5. Recommended Stack with Justification\n` +
            `6. Tradeoffs & Alternatives\n` +
            `7. Migration Path (if applicable)`
        );

        const outputPath = task.outputPath ?? 'docs/design/tech-stack.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async designApi(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Designing API endpoints...');

        const response = await this.askAI(
            `Design the API for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. API Overview\n` +
            `2. Endpoints Table (method, path, description, auth)\n` +
            `3. Request/Response Schemas (JSON examples)\n` +
            `4. Error Response Format\n` +
            `5. Authentication & Authorization\n` +
            `6. Rate Limiting Strategy\n` +
            `7. Versioning Strategy`
        );

        const outputPath = task.outputPath ?? 'docs/design/api-design.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async designDatabase(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Designing database schema...');

        const response = await this.askAI(
            `Design the database for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. ERD (mermaid diagram)\n` +
            `2. Table Definitions (CREATE TABLE SQL)\n` +
            `3. Indexes Strategy\n` +
            `4. Relationships & Constraints\n` +
            `5. Migration Scripts\n` +
            `6. Seed Data\n` +
            `7. Query Patterns & Optimization Notes`
        );

        const outputPath = task.outputPath ?? 'docs/design/database-design.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async reviewArchitecture(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Reviewing existing architecture...');

        const response = await this.askAI(
            `Review the architecture for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Current Architecture Summary\n` +
            `2. Identified Issues (CRITICAL/HIGH/MEDIUM/LOW)\n` +
            `3. Scalability Concerns\n` +
            `4. Security Concerns\n` +
            `5. Recommendations\n` +
            `6. Proposed Changes (with effort estimates)`
        );

        const outputPath = task.outputPath ?? 'docs/design/architecture-review.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeAdr(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing Architecture Decision Record...');

        const response = await this.askAI(
            `Write an Architecture Decision Record (ADR) for:\n\n` +
            `Decision: ${task.title}\n` +
            `Context: ${task.description}\n\n` +
            `Use this format:\n` +
            `# ADR-NNN: [Title]\n` +
            `## Status: Proposed\n` +
            `## Context\n` +
            `## Decision\n` +
            `## Alternatives Considered\n` +
            `## Consequences\n` +
            `## Notes`
        );

        const outputPath = task.outputPath ?? `docs/decisions/adr-${Date.now()}.md`;
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    /** Decompose a project/feature into structured 2-5 minute task specs */
    async decomposeIntoTasks(task: TaskInfo): Promise<readonly TaskSpec[]> {
        await this.reportProgress(task, 'Decomposing into structured task specs...');

        const phase = task.phase ?? 'Development';
        const prompt = buildDecompositionPrompt(task.description, phase);

        const response = await this.askAI(prompt);
        const specs = parseTaskSpecs(response.text);
        const warnings = validateTaskSpecs(specs);

        if (warnings.length > 0) {
            console.warn('[Blueprint] Task spec warnings:', warnings);
        }

        const outputPath = task.outputPath ?? 'docs/design/task-specs.md';
        await this.writeFile(task.repoPath, outputPath, response.text);

        return specs;
    }

    private async handleGenericTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, `Working on: ${task.title}...`);

        const response = await this.askAI(
            `Complete the following architecture task:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Output a well-structured technical document.`
        );

        const outputPath = task.outputPath ?? `docs/design/${task.taskType}.md`;
        await this.writeFile(task.repoPath, outputPath, response.text);
    }
}
