/**
 * Risk Scorer — B-206
 *
 * Computes risk scores for changed files using code-graph data,
 * prioritises them for Vigil's review pipeline.
 */

// ── Interfaces ────────────────────────────────────────

export interface RiskScoredFile {
    readonly filePath: string;
    readonly riskScore: number;        // 0-10, higher = riskier
    readonly reasons: readonly string[]; // why this file is risky
    readonly hasTestGap: boolean;
    readonly blastRadius: number;      // how many other files depend on this
}

export interface RiskPrioritizedReview {
    readonly files: readonly RiskScoredFile[];
    readonly highRiskFiles: readonly string[];   // score >= 7
    readonly mediumRiskFiles: readonly string[]; // score 4-6
    readonly lowRiskFiles: readonly string[];    // score <= 3
    readonly overallRisk: number;
    readonly summary: string;
}

// ── Input parameter shapes ────────────────────────────

export interface ChangedFunctionParam {
    readonly name: string;
    readonly riskScore: number;
    readonly testGap: boolean;
}

export interface BlastRadiusParam {
    readonly filePath: string;
    readonly calledBy: readonly string[];
}

export interface TestGapParam {
    readonly filePath: string;
    readonly hasCoverage: boolean;
}

// ── scoreFileRisk ─────────────────────────────────────

/**
 * Calculate a risk score for a single file.
 *
 * Scoring rules:
 *   - Base: average riskScore of changed functions in this file (0-10)
 *   - Test gap:   +2 if any function in this file has testGap === true
 *                 OR if the file appears in testGaps with hasCoverage === false
 *   - Blast radius: +0.5 per caller, capped at +3
 *   - Final score clamped to [0, 10]
 */
export function scoreFileRisk(
    filePath: string,
    changedFunctions: readonly ChangedFunctionParam[],
    blastRadius: readonly BlastRadiusParam[],
    testGaps: readonly TestGapParam[]
): RiskScoredFile {
    const reasons: string[] = [];

    // Functions that belong to this file
    const fileFunctions = changedFunctions.filter((f) => {
        // changedFunctions may carry filePath if using full ChangedFunction,
        // but the spec only passes name/riskScore/testGap.
        // We treat ALL passed functions as belonging to this file.
        return true;
    });

    // Base: average function risk score
    let baseScore = 0;
    if (fileFunctions.length > 0) {
        const total = fileFunctions.reduce((sum, f) => sum + f.riskScore, 0);
        baseScore = total / fileFunctions.length;
        reasons.push(`${fileFunctions.length} changed function(s), avg risk ${baseScore.toFixed(1)}`);
    }

    // Test-gap penalty
    const functionHasGap = fileFunctions.some((f) => f.testGap);
    const fileHasGap = testGaps.some((g) => g.filePath === filePath && !g.hasCoverage);
    const hasTestGap = functionHasGap || fileHasGap;
    let testGapBonus = 0;
    if (hasTestGap) {
        testGapBonus = 2;
        reasons.push('test gap detected (+2)');
    }

    // Blast-radius penalty
    const blastEntry = blastRadius.find((b) => b.filePath === filePath);
    const callerCount = blastEntry !== undefined ? blastEntry.calledBy.length : 0;
    const blastBonus = Math.min(callerCount * 0.5, 3);
    if (callerCount > 0) {
        reasons.push(`blast radius: ${callerCount} caller(s) (+${blastBonus.toFixed(1)})`);
    }

    const raw = baseScore + testGapBonus + blastBonus;
    const riskScore = Math.min(10, Math.max(0, raw));

    return {
        filePath,
        riskScore,
        reasons,
        hasTestGap,
        blastRadius: callerCount,
    };
}

// ── prioritizeByRisk ──────────────────────────────────

/**
 * Sort files by descending risk, bucket into high/medium/low,
 * compute overall risk (max of all scores), and build a summary.
 */
export function prioritizeByRisk(
    scoredFiles: readonly RiskScoredFile[]
): RiskPrioritizedReview {
    if (scoredFiles.length === 0) {
        return {
            files: [],
            highRiskFiles: [],
            mediumRiskFiles: [],
            lowRiskFiles: [],
            overallRisk: 0,
            summary: 'No files to review.',
        };
    }

    const sorted = [...scoredFiles].sort((a, b) => b.riskScore - a.riskScore);

    const highRiskFiles: string[] = [];
    const mediumRiskFiles: string[] = [];
    const lowRiskFiles: string[] = [];

    for (const f of sorted) {
        if (f.riskScore >= 7) {
            highRiskFiles.push(f.filePath);
        } else if (f.riskScore >= 4) {
            mediumRiskFiles.push(f.filePath);
        } else {
            lowRiskFiles.push(f.filePath);
        }
    }

    const overallRisk = sorted[0].riskScore;

    const summaryParts: string[] = [
        `${sorted.length} file(s) scored.`,
        `High risk: ${highRiskFiles.length}.`,
        `Medium risk: ${mediumRiskFiles.length}.`,
        `Low risk: ${lowRiskFiles.length}.`,
        `Overall risk: ${overallRisk.toFixed(1)}/10.`,
    ];

    return {
        files: sorted,
        highRiskFiles,
        mediumRiskFiles,
        lowRiskFiles,
        overallRisk,
        summary: summaryParts.join(' '),
    };
}

// ── buildRiskAwareReviewPrompt ────────────────────────

/**
 * Build a review prompt for Vigil that directs attention to the
 * highest-risk files first and calls out test gaps.
 */
export function buildRiskAwareReviewPrompt(
    prioritized: RiskPrioritizedReview,
    taskTitle: string
): string {
    const lines: string[] = [
        `# Risk-Aware Code Review: ${taskTitle}`,
        '',
        `**Overall Risk Score:** ${prioritized.overallRisk.toFixed(1)}/10`,
        `**${prioritized.summary}**`,
        '',
    ];

    if (prioritized.highRiskFiles.length > 0) {
        lines.push('## PRIORITY: Review these high-risk files first:');
        for (const f of prioritized.highRiskFiles) {
            const scored = prioritized.files.find((s) => s.filePath === f);
            const score = scored !== undefined ? ` (score ${scored.riskScore.toFixed(1)})` : '';
            lines.push(`- ${f}${score}`);
        }
        lines.push('');
    }

    // Test-gap warnings
    const filesWithGaps = prioritized.files.filter((f) => f.hasTestGap);
    if (filesWithGaps.length > 0) {
        lines.push('## Test Gap Warnings');
        lines.push('The following files have insufficient test coverage — pay extra attention:');
        for (const f of filesWithGaps) {
            lines.push(`- ${f.filePath}`);
        }
        lines.push('');
    }

    // Blast-radius concerns
    const blastConcerns = prioritized.files.filter((f) => f.blastRadius > 1);
    if (blastConcerns.length > 0) {
        lines.push('## Blast Radius Concerns');
        lines.push('Changes here propagate to multiple dependants — verify no regressions:');
        for (const f of blastConcerns) {
            lines.push(`- ${f.filePath} — ${f.blastRadius} dependent(s)`);
        }
        lines.push('');
    }

    if (prioritized.mediumRiskFiles.length > 0) {
        lines.push('## Medium Risk Files');
        for (const f of prioritized.mediumRiskFiles) {
            lines.push(`- ${f}`);
        }
        lines.push('');
    }

    if (prioritized.lowRiskFiles.length > 0) {
        lines.push('## Low Risk Files (review last)');
        for (const f of prioritized.lowRiskFiles) {
            lines.push(`- ${f}`);
        }
        lines.push('');
    }

    lines.push('---');
    lines.push('Review each file for: correctness, spec compliance, security, and maintainability.');
    lines.push('Categorize findings as CRITICAL, HIGH, MEDIUM, or LOW.');

    return lines.join('\n');
}

// ── formatRiskReport ──────────────────────────────────

/**
 * Produce a markdown risk-heatmap table for the review report.
 */
export function formatRiskReport(prioritized: RiskPrioritizedReview): string {
    const lines: string[] = [
        '# Risk Heatmap Report',
        '',
        `**Overall Risk:** ${prioritized.overallRisk.toFixed(1)}/10`,
        `**${prioritized.summary}**`,
        '',
        '| File | Score | Reasons | Test Gap | Blast Radius |',
        '|------|-------|---------|----------|--------------|',
    ];

    for (const f of prioritized.files) {
        const score = f.riskScore.toFixed(1);
        const reasons = f.reasons.join('; ') || '—';
        const testGap = f.hasTestGap ? 'YES' : 'no';
        const blast = f.blastRadius > 0 ? String(f.blastRadius) : '0';
        lines.push(`| ${f.filePath} | ${score} | ${reasons} | ${testGap} | ${blast} |`);
    }

    return lines.join('\n');
}
