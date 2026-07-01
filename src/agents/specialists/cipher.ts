/**
 * Cipher — Data Specialist Agent
 *
 * Handles data modeling, ETL/pipeline design, SQL, analytics,
 * data quality, schema migrations, and ML pipeline architecture.
 * Primary agent for data-intensive tasks across all phases.
 */

import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';
import { withGrounding } from '../grounding';

// ── Constants ────────────────────────────────────────

const CIPHER_SKILLS = [
    'data-pipeline',
    'etl',
    'sql',
    'data-modeling',
    'analytics',
    'machine-learning',
    'data-quality',
    'schema-design',
] as const;

const SYSTEM_PROMPT =
    'You are Cipher, a data specialist and analyst. You think in schemas, pipelines, ' +
    'and transformations. You ensure data quality, optimize queries, and build reliable ' +
    'data infrastructure. Your outputs include ERDs, SQL scripts, pipeline diagrams, and data quality rules.';

// ── Cipher Agent ─────────────────────────────────────

export class Cipher extends AutonautAgent {
    constructor(modelConfig: AgentModelConfig) {
        super('cipher', 'data-specialist', CIPHER_SKILLS, modelConfig, withGrounding(SYSTEM_PROMPT));
    }

    async executeTask(task: TaskInfo): Promise<void> {
        switch (task.taskType) {
            case 'data-model':
                await this.writeDataModel(task);
                break;
            case 'data-pipeline':
                await this.writeDataPipeline(task);
                break;
            case 'sql-query':
                await this.writeSqlQuery(task);
                break;
            case 'analytics':
                await this.writeAnalytics(task);
                break;
            case 'data-quality':
                await this.writeDataQuality(task);
                break;
            case 'schema-migration':
                await this.writeSchemaMigration(task);
                break;
            case 'ml-pipeline':
                await this.writeMlPipeline(task);
                break;
            default:
                await this.handleGenericTask(task);
                break;
        }
    }

    private async writeDataModel(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Designing data model and entity relationships...');

        const response = await this.askAI(
            `Design a data model for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Entity-Relationship Diagram (ASCII or Mermaid)\n` +
            `2. Table Definitions (columns, types, constraints)\n` +
            `3. Primary/Foreign Key Relationships\n` +
            `4. Indexes (performance-critical queries)\n` +
            `5. Normalization Level & Rationale\n` +
            `6. Sample Data (for each table)`
        );

        const outputPath = task.outputPath ?? 'data/schemas/data-model.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
        await this.reportProgress(task, `Data model written to ${outputPath}`);
    }

    private async writeDataPipeline(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Architecting data pipeline...');

        const response = await this.askAI(
            `Design a data pipeline for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Pipeline Architecture Diagram (ASCII/Mermaid)\n` +
            `2. Data Sources & Sinks\n` +
            `3. Transformation Steps (ETL stages)\n` +
            `4. Scheduling & Orchestration\n` +
            `5. Error Handling & Retry Strategy\n` +
            `6. Monitoring & Alerting\n` +
            `7. Data Quality Checkpoints`
        );

        const outputPath = task.outputPath ?? 'data/pipelines/pipeline.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeSqlQuery(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing SQL queries and views...');

        const response = await this.askAI(
            `Write SQL queries for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Query Definitions (with comments)\n` +
            `2. Views for Common Aggregations\n` +
            `3. Index Recommendations\n` +
            `4. Query Execution Plans (explain)\n` +
            `5. Parameterized Query Variants\n` +
            `6. Performance Notes`
        );

        const outputPath = task.outputPath ?? 'data/sql-queries.sql';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeAnalytics(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Defining analytics queries and KPIs...');

        const response = await this.askAI(
            `Create analytics specifications for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. KPI Definitions (metric, formula, target)\n` +
            `2. Dashboard Layout (panels, charts, filters)\n` +
            `3. Analytics Queries (SQL)\n` +
            `4. Data Refresh Strategy\n` +
            `5. Drill-Down Paths\n` +
            `6. Alert Thresholds`
        );

        const outputPath = task.outputPath ?? 'data/analytics.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeDataQuality(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Defining data quality rules and validation...');

        const response = await this.askAI(
            `Create a data quality framework for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Quality Dimensions (completeness, accuracy, consistency, timeliness)\n` +
            `2. Validation Rules (per table/field)\n` +
            `3. Anomaly Detection Rules\n` +
            `4. Data Profiling Queries\n` +
            `5. Monitoring & Alerting Thresholds\n` +
            `6. Remediation Procedures`
        );

        const outputPath = task.outputPath ?? 'data/data-quality.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeSchemaMigration(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing schema migration scripts...');

        const response = await this.askAI(
            `Create database migration scripts for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Up Migration (CREATE/ALTER statements)\n` +
            `2. Down Migration (rollback statements)\n` +
            `3. Data Migration (if needed)\n` +
            `4. Dependency Order\n` +
            `5. Pre-Migration Checks\n` +
            `6. Post-Migration Validation\n\n` +
            `MUST APPLY ON A FRESH DATABASE (NON-NEGOTIABLE):\n` +
            `- The migration set will be applied top-to-bottom on an EMPTY database.\n` +
            `  "It parses" is not "it applies". Order statements so nothing is used\n` +
            `  before it is declared.\n` +
            `- DECLARE BEFORE USE: every enum/custom type (CREATE TYPE ... AS ENUM),\n` +
            `  extension (CREATE EXTENSION), and referenced table must exist BEFORE the\n` +
            `  first statement that uses it. A column typed \`refund_status\` requires a\n` +
            `  prior \`CREATE TYPE refund_status AS ENUM (...)\`; an FK requires the\n` +
            `  referenced table to be created first.\n` +
            `- SEED MUST MATCH THE AUTH MODEL: if auth is delegated (Clerk, Supabase\n` +
            `  Auth), do NOT add a \`password_hash\`/password column and do NOT seed\n` +
            `  hardcoded user rows or IDs — accounts are created through the provider and\n` +
            `  app tables FK to the provider's user id. Only seed your own domain tables.`
        );

        const outputPath = task.outputPath ?? 'data/migrations/migration.sql';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeMlPipeline(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Designing ML pipeline architecture...');

        const response = await this.askAI(
            `Design an ML pipeline for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `1. Pipeline Architecture (data prep → training → evaluation → deployment)\n` +
            `2. Feature Engineering Plan\n` +
            `3. Model Selection Rationale\n` +
            `4. Training & Evaluation Strategy\n` +
            `5. Model Serving Architecture\n` +
            `6. Monitoring & Retraining Triggers\n` +
            `7. A/B Testing Framework`
        );

        const outputPath = task.outputPath ?? 'data/models/ml-pipeline.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async handleGenericTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, `Working on data task: ${task.title}...`);

        const response = await this.askAI(
            `Complete the following data task:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Write a well-structured markdown document as your output.`
        );

        const outputPath = task.outputPath ?? `data/${task.taskType}.md`;
        await this.writeFile(task.repoPath, outputPath, response.text);
    }
}
