/**
 * Vigil — Quality Guardian Agent
 *
 * Handles code review, testing, security review, documentation,
 * and quality gates. Never lets substandard work pass.
 */

import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';
import {
    buildStage1Prompt,
    buildStage2Prompt,
    parseStageVerdict,
    shouldSkipStage2,
    combineTwoStageResults,
} from '../review-stages';
import {
    DEFAULT_FLEET_ROLES,
    buildFleetPrompt,
    parseFleetFindings,
    deduplicateFindings,
    rankFindings,
    buildFleetResult,
    type FleetFinding,
} from '../review-fleet';
import { getCodeGraphBridge } from '../../workspace/code-graph-bridge';
import {
    scoreFileRisk,
    prioritizeByRisk,
    buildRiskAwareReviewPrompt,
    formatRiskReport,
} from '../risk-scorer';
import {
    runStaticChecks,
    formatViolationsReport,
} from './vigil-static-checks';

// ── Constants ────────────────────────────────────────

const VIGIL_SKILLS = [
    'code-review',
    'testing',
    'security-review',
    'documentation',
    'compliance',
    'performance-testing',
    'accessibility',
    'test-automation',
] as const;

const SYSTEM_PROMPT =
    'You are Vigil, a quality guardian. You catch bugs before users do. You are thorough, ' +
    'methodical, and never let substandard work pass. If something is wrong, you say so clearly. ' +
    'You categorize findings as CRITICAL, HIGH, MEDIUM, or LOW severity.';

// ── Vigil Agent ──────────────────────────────────────

export class Vigil extends AutonautAgent {
    constructor(modelConfig: AgentModelConfig) {
        super('vigil', 'quality-guardian', VIGIL_SKILLS, modelConfig, SYSTEM_PROMPT);
    }

    async executeTask(task: TaskInfo): Promise<void> {
        switch (task.taskType) {
            case 'code-review':
                await this.reviewCode(task);
                break;
            case 'write-tests':
                await this.writeTests(task);
                break;
            case 'security-review':
                await this.securityReview(task);
                break;
            case 'documentation':
                await this.writeDocumentation(task);
                break;
            case 'run-tests':
                await this.runTests(task);
                break;
            case 'quality-gate':
                await this.runQualityGate(task);
                break;
            case 'fleet-review':
                await this.fleetReview(task);
                break;
            case 'risk-review':
                await this.riskReview(task);
                break;
            default:
                await this.handleGenericTask(task);
                break;
        }
    }

    private async reviewCode(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Deterministic pre-checks...');

        // Gather all reviewable files (include HTML + package.json for deterministic checks)
        const allFiles = this.listFiles(task.repoPath, '\\.(ts|tsx|js|jsx|mjs|cjs|html|htm)$');
        const fileMap = new Map<string, string>();
        for (const file of allFiles.slice(0, 40)) {
            try {
                fileMap.set(file.replace(/\\/g, '/'), this.readFile(task.repoPath, file));
            } catch {
                // Skip unreadable files
            }
        }
        try {
            fileMap.set('package.json', this.readFile(task.repoPath, 'package.json'));
        } catch {
            // No package.json at root — fine, dual-scaffold check just skips
        }

        // Run deterministic checks BEFORE any LLM call. If they fail, reject immediately.
        const staticResult = runStaticChecks(fileMap);
        if (!staticResult.passed) {
            const report = formatViolationsReport(staticResult.violations);
            const outputPath = task.outputPath ?? 'docs/reviews/code-review.md';
            await this.writeFile(task.repoPath, outputPath, report);

            await this.publishEvent('review.rejected', {
                qualityScore: 2,
                hasCriticalFindings: staticResult.violations.some((v) => v.severity === 'critical'),
                reviewPath: outputPath,
                summary: `Deterministic: ${staticResult.summary}`,
                stage1Score: 2,
                stage2Score: null,
                stage2Skipped: true,
                deterministicViolations: staticResult.violations.length,
            });
            return;
        }

        await this.reportProgress(task, 'Stage 1: Checking spec compliance...');

        // Gather code files for LLM review (TS/JS only)
        const codeFiles = this.listFiles(task.repoPath, '\\.(ts|tsx|js|jsx)$');
        const fileContents: string[] = [];

        for (const file of codeFiles.slice(0, 20)) {
            try {
                const content = this.readFile(task.repoPath, file);
                fileContents.push(`--- ${file} ---\n${content}`);
            } catch {
                // Skip unreadable files
            }
        }

        // Augment review with code graph context (v0.8 — null-safe, no-op if bridge absent)
        const graphContext = await this.getCodeGraphReviewContext(task.repoPath, codeFiles.slice(0, 20));

        const codeContext = graphContext !== null
            ? `${graphContext}\n\n## Source Files\n${fileContents.join('\n\n')}`
            : fileContents.join('\n\n');

        // Stage 1: Spec Compliance
        const stage1Prompt = buildStage1Prompt(task.title, task.description);
        const stage1Response = await this.askAI(stage1Prompt, codeContext);
        const stage1Result = parseStageVerdict(stage1Response.text, 1);

        let stage2Result = null;
        let combinedOutput = `# Two-Stage Code Review\n\n## Stage 1: Spec Compliance\n\n${stage1Response.text}`;

        if (shouldSkipStage2(stage1Result)) {
            combinedOutput += '\n\n## Stage 2: SKIPPED\n\n' +
                'Stage 1 score was below threshold — spec compliance must be addressed before code quality review.';
        } else {
            // Stage 2: Code Quality
            await this.reportProgress(task, 'Stage 2: Reviewing code quality...');
            const stage2Prompt = buildStage2Prompt(task.title);
            const stage2Response = await this.askAI(stage2Prompt, codeContext);
            stage2Result = parseStageVerdict(stage2Response.text, 2);
            combinedOutput += `\n\n## Stage 2: Code Quality\n\n${stage2Response.text}`;
        }

        const combined = combineTwoStageResults(stage1Result, stage2Result);

        const outputPath = task.outputPath ?? 'docs/reviews/code-review.md';
        await this.writeFile(task.repoPath, outputPath, combinedOutput);

        await this.publishEvent(
            combined.overallPassed ? 'review.passed' : 'review.rejected',
            {
                qualityScore: combined.overallScore,
                hasCriticalFindings: combined.importantCount > 0,
                reviewPath: outputPath,
                summary: `Stage1: ${stage1Result.summary} | Stage2: ${stage2Result !== null ? stage2Result.summary : 'Skipped'}`,
                stage1Score: stage1Result.qualityScore,
                stage2Score: stage2Result !== null ? stage2Result.qualityScore : null,
                stage2Skipped: stage2Result === null,
            }
        );
    }

    private async writeTests(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing comprehensive tests...');

        const response = await this.askAI(
            `Write tests for:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Requirements:\n` +
            `- Unit tests for all public functions\n` +
            `- Edge case coverage\n` +
            `- Integration tests for API endpoints (if applicable)\n` +
            `- Use vitest as the test framework\n` +
            `- Target 80%+ coverage\n\n` +
            `Output format: For each file, use this format:\n` +
            `--- FILE: path/to/file.test.ts ---\n` +
            `[file content]\n` +
            `--- END FILE ---`
        );

        await this.writeOutputFiles(task, response.text);
    }

    private async securityReview(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Scanning for security vulnerabilities...');

        const codeFiles = this.listFiles(task.repoPath, '\\.(ts|tsx|js|jsx|json|yml|yaml|env)$');
        const fileContents: string[] = [];

        for (const file of codeFiles.slice(0, 30)) {
            try {
                const content = this.readFile(task.repoPath, file);
                fileContents.push(`--- ${file} ---\n${content}`);
            } catch {
                // Skip unreadable files
            }
        }

        const response = await this.askAI(
            `Perform a security review.\n\n` +
            `Focus: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Check for:\n` +
            `1. Hardcoded secrets (API keys, passwords, tokens)\n` +
            `2. SQL injection vulnerabilities\n` +
            `3. XSS vulnerabilities\n` +
            `4. Insecure dependencies\n` +
            `5. Improper error handling (information leaks)\n` +
            `6. Authentication/authorization issues\n` +
            `7. CSRF vulnerabilities\n` +
            `8. Path traversal\n` +
            `9. Sensitive data exposure\n\n` +
            `For each finding, specify severity and remediation.`,
            fileContents.join('\n\n')
        );

        const outputPath = task.outputPath ?? 'docs/reviews/security-review.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async writeDocumentation(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Writing documentation...');

        const response = await this.askAI(
            `Write documentation for:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `- Overview\n` +
            `- Getting Started\n` +
            `- API Reference (if applicable)\n` +
            `- Configuration\n` +
            `- Troubleshooting\n` +
            `- Examples`
        );

        const outputPath = task.outputPath ?? 'docs/README.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async runTests(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Running test suite...');

        const response = await this.askAI(
            `Analyze the test results and report:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Include:\n` +
            `- Test summary (passed/failed/skipped)\n` +
            `- Failed test details\n` +
            `- Flaky test identification\n` +
            `- Coverage report\n` +
            `- Recommendations`
        );

        const outputPath = task.outputPath ?? 'docs/reviews/test-report.md';
        await this.writeFile(task.repoPath, outputPath, response.text);
    }

    private async runQualityGate(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Running full quality gate check...');

        const response = await this.askAI(
            `Run a full quality gate check for:\n\n` +
            `Project: ${task.title}\n` +
            `Description: ${task.description}\n\n` +
            `Quality gate criteria:\n` +
            `1. Build passes ✅/❌\n` +
            `2. Unit tests pass ✅/❌\n` +
            `3. Lint/format clean ✅/❌\n` +
            `4. No secrets detected ✅/❌\n` +
            `5. Coverage ≥ 80% ✅/❌\n\n` +
            `Output: PASSED or REJECTED with details.`
        );

        const outputPath = task.outputPath ?? 'docs/reviews/quality-gate.md';
        await this.writeFile(task.repoPath, outputPath, response.text);

        // Publish review result event
        const passed = response.text.toLowerCase().includes('passed');
        // The event will be published by the base class on task completion
        // But we could extend this to publish review.passed/review.rejected
    }

    private async fleetReview(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Fleet review: gathering code files...');

        // Gather code files (same approach as reviewCode)
        const codeFiles = this.listFiles(task.repoPath, '\\.(ts|tsx|js|jsx)$');
        const fileContents: string[] = [];

        for (const file of codeFiles.slice(0, 20)) {
            try {
                const content = this.readFile(task.repoPath, file);
                fileContents.push(`--- ${file} ---\n${content}`);
            } catch {
                // Skip unreadable files
            }
        }

        const codeContext = fileContents.join('\n\n');
        const allFindings: FleetFinding[] = [];

        // Run each sub-reviewer role sequentially (simulating fleet pattern)
        for (const role of DEFAULT_FLEET_ROLES) {
            await this.reportProgress(task, `Fleet review: running ${role} sub-reviewer...`);

            const prompt = buildFleetPrompt(role, task.title, codeContext);
            const response = await this.askAI(prompt);
            const roleFindings = parseFleetFindings(response.text, role);

            for (const finding of roleFindings) {
                allFindings.push(finding);
            }
        }

        const originalCount = allFindings.length;
        const deduplicated = deduplicateFindings(allFindings);
        const ranked = rankFindings(deduplicated);
        const result = buildFleetResult(ranked, originalCount);

        // Build combined output report
        const outputLines: string[] = [
            '# Fleet Review Report',
            '',
            `**Task:** ${task.title}`,
            `**Roles run:** ${DEFAULT_FLEET_ROLES.join(', ')}`,
            `**Findings:** ${result.deduplicatedCount} (${originalCount} before dedup)`,
            '',
            '## Summary by Role',
            ...DEFAULT_FLEET_ROLES.map(r => `- **${r}**: ${result.totalByRole[r]} finding(s)`),
            '',
            '## Summary by Severity',
            ...Object.entries(result.totalBySeverity).map(([sev, count]) => `- **${sev}**: ${count}`),
            '',
            '## Findings',
            '',
        ];

        for (const finding of result.findings) {
            outputLines.push(`### [${finding.severity.toUpperCase()}] ${finding.file}${finding.line !== null ? `:${finding.line}` : ''}`);
            outputLines.push(`**Role:** ${finding.role}`);
            outputLines.push(`**Issue:** ${finding.message}`);
            if (finding.suggestion.length > 0) {
                outputLines.push(`**Suggestion:** ${finding.suggestion}`);
            }
            outputLines.push('');
        }

        if (result.findings.length === 0) {
            outputLines.push('No findings — code looks clean across all review areas.');
        }

        const outputPath = task.outputPath ?? 'docs/reviews/fleet-review.md';
        await this.writeFile(task.repoPath, outputPath, outputLines.join('\n'));

        const hasCritical = (result.totalBySeverity['critical'] ?? 0) > 0;
        const hasHigh = (result.totalBySeverity['high'] ?? 0) > 0;

        await this.publishEvent('review.fleet-completed', {
            totalFindings: result.deduplicatedCount,
            originalCount,
            totalByRole: result.totalByRole,
            totalBySeverity: result.totalBySeverity,
            hasCritical,
            hasHigh,
            reviewPath: outputPath,
        });
    }

    private async riskReview(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Risk review: detecting changes...');

        const bridge = getCodeGraphBridge();

        // Attempt structured risk-scored review; fall back to normal reviewCode on error
        let changesResult = null;
        let reviewContextResult = null;
        try {
            changesResult = await bridge.detectChanges(task.repoPath, 'HEAD~1');
            if (changesResult !== null && changesResult.affectedFiles.length > 0) {
                reviewContextResult = await bridge.getReviewContext(
                    task.repoPath,
                    changesResult.affectedFiles
                );
            }
        } catch {
            // Bridge unavailable — fall back to normal reviewCode
        }

        if (changesResult === null || reviewContextResult === null) {
            await this.reportProgress(task, 'Risk review: code graph unavailable, falling back to standard review');
            await this.reviewCode(task);
            return;
        }

        await this.reportProgress(task, 'Risk review: scoring files by risk...');

        const { changedFunctions, affectedFiles } = changesResult;
        const { blastRadius, testGaps } = reviewContextResult;

        // Score each affected file
        const scoredFiles = affectedFiles.map((filePath) => {
            const fileFunctions = changedFunctions.filter((fn) => fn.filePath === filePath);
            return scoreFileRisk(filePath, fileFunctions, blastRadius, testGaps);
        });

        const prioritized = prioritizeByRisk(scoredFiles);
        const reviewPrompt = buildRiskAwareReviewPrompt(prioritized, task.title);
        const riskReport = formatRiskReport(prioritized);

        await this.reportProgress(task, 'Risk review: running AI review with risk context...');

        const response = await this.askAI(reviewPrompt);

        // Write risk report
        const riskReportPath = task.outputPath !== null
            ? task.outputPath.replace(/\.md$/, '-risk-heatmap.md')
            : 'docs/reviews/risk-heatmap.md';
        await this.writeFile(task.repoPath, riskReportPath, riskReport);

        // Write AI review
        const reviewPath = task.outputPath ?? 'docs/reviews/risk-review.md';
        await this.writeFile(task.repoPath, reviewPath, response.text);

        await this.publishEvent('review.risk-scored', {
            overallRisk: prioritized.overallRisk,
            highRiskCount: prioritized.highRiskFiles.length,
            mediumRiskCount: prioritized.mediumRiskFiles.length,
            lowRiskCount: prioritized.lowRiskFiles.length,
            highRiskFiles: prioritized.highRiskFiles,
            reviewPath,
            riskReportPath,
            summary: prioritized.summary,
        });
    }

    private async handleGenericTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, `Working on: ${task.title}...`);

        const response = await this.askAI(
            `Complete the following quality task:\n\n` +
            `Title: ${task.title}\n` +
            `Description: ${task.description}`
        );

        const outputPath = task.outputPath ?? `docs/reviews/${task.taskType}.md`;
        await this.writeFile(task.repoPath, outputPath, response.text);
    }
}

// ── Review Verdict Parsing ──────────────────────────

export interface ReviewVerdict {
    readonly qualityScore: number;
    readonly passed: boolean;
    readonly criticalCount: number;
    readonly summary: string;
}

/**
 * Parse a review verdict from Vigil's AI output.
 * Tries structured block first, falls back to loose regex.
 */
export function parseReviewVerdict(aiOutput: string): ReviewVerdict {
    // Try structured verdict block
    const verdictBlock = aiOutput.match(
        /--- REVIEW VERDICT ---\s*\n([\s\S]*?)--- END VERDICT ---/
    );

    if (verdictBlock !== null) {
        const block = verdictBlock[1];
        const scoreMatch = block.match(/QUALITY_SCORE:\s*(\d+)/);
        const verdictMatch = block.match(/VERDICT:\s*(PASSED|REJECTED)/i);
        const criticalMatch = block.match(/CRITICAL_COUNT:\s*(\d+)/);
        const summaryMatch = block.match(/SUMMARY:\s*(.+)/);

        const qualityScore = scoreMatch !== null ? parseInt(scoreMatch[1], 10) : 5;
        const passed = verdictMatch !== null ? verdictMatch[1].toUpperCase() === 'PASSED' : qualityScore >= 6;

        return {
            qualityScore: Math.min(10, Math.max(1, qualityScore)),
            passed,
            criticalCount: criticalMatch !== null ? parseInt(criticalMatch[1], 10) : 0,
            summary: summaryMatch !== null ? summaryMatch[1].trim() : 'Review completed',
        };
    }

    // Fallback: loose regex parsing
    const scoreMatch = aiOutput.match(/quality\s*score[:\s]*(\d+)/i);
    const qualityScore = scoreMatch !== null ? parseInt(scoreMatch[1], 10) : 5;
    const hasCritical = aiOutput.toLowerCase().includes('critical');
    const passed = qualityScore >= 6 && !hasCritical;

    return {
        qualityScore: Math.min(10, Math.max(1, qualityScore)),
        passed,
        criticalCount: hasCritical ? 1 : 0,
        summary: 'Review completed (parsed from unstructured output)',
    };
}
