/**
 * Two-Stage Review System
 *
 * Stage 1: Spec Compliance — does the implementation match the specification?
 * Stage 2: Code Quality — is the implementation well-written?
 *
 * Inspired by Superpowers two-stage review and Anthropic Code Review fleet.
 */

export type ReviewSeverity = 'important' | 'nit' | 'pre-existing';

export interface ReviewFinding {
    readonly severity: ReviewSeverity;
    readonly file: string;
    readonly line: number | null;
    readonly category: string;
    readonly description: string;
    readonly suggestedFix: string;
    readonly stage: 1 | 2;
}

export interface StageResult {
    readonly stage: 1 | 2;
    readonly stageName: string;
    readonly passed: boolean;
    readonly qualityScore: number;
    readonly findings: readonly ReviewFinding[];
    readonly summary: string;
}

export interface TwoStageReviewResult {
    readonly stage1: StageResult;
    readonly stage2: StageResult | null;
    readonly overallPassed: boolean;
    readonly overallScore: number;
    readonly allFindings: readonly ReviewFinding[];
    readonly importantCount: number;
    readonly nitCount: number;
    readonly preExistingCount: number;
}

/** Stage 1 failure threshold — below this, skip Stage 2 entirely */
const STAGE1_SKIP_THRESHOLD = 4;

/** Build the prompt for Stage 1: Spec Compliance */
export function buildStage1Prompt(taskTitle: string, taskDescription: string): string {
    return [
        'STAGE 1: SPECIFICATION COMPLIANCE REVIEW',
        '',
        'You are reviewing whether the implementation matches the task specification.',
        'Do NOT review code quality yet — that is Stage 2.',
        '',
        `Task: ${taskTitle}`,
        `Specification: ${taskDescription}`,
        '',
        'Check:',
        '1. Does the implementation fulfill ALL requirements in the specification?',
        '2. Are there any requirements that were missed or partially implemented?',
        '3. Does the implementation do anything NOT specified (scope creep)?',
        '4. Are the interfaces/APIs correct per the spec?',
        '',
        'For each finding:',
        '- Severity: important | nit | pre-existing',
        '- Category: spec-mismatch | missing-requirement | scope-creep | wrong-interface',
        '- File and line (approximate)',
        '- Description',
        '- Suggested fix',
        '',
        'At the end, include this exact block:',
        '--- STAGE 1 VERDICT ---',
        'QUALITY_SCORE: <1-10>',
        'VERDICT: PASSED | REJECTED',
        'IMPORTANT_COUNT: <number>',
        'NIT_COUNT: <number>',
        'SUMMARY: <one-line summary>',
        '--- END VERDICT ---',
    ].join('\n');
}

/** Build the prompt for Stage 2: Code Quality */
export function buildStage2Prompt(taskTitle: string): string {
    return [
        'STAGE 2: CODE QUALITY REVIEW',
        '',
        'The implementation has passed spec compliance (Stage 1).',
        'Now review the CODE QUALITY.',
        '',
        `Task: ${taskTitle}`,
        '',
        'Check:',
        '1. Logic bugs — incorrect behavior, race conditions, off-by-one errors',
        '2. Security — injection, XSS, authentication gaps, secret exposure',
        '3. Edge cases — null handling, empty arrays, boundary conditions',
        '4. Performance — N+1 queries, unnecessary re-renders, memory leaks',
        '5. Error handling — swallowed errors, missing try/catch, unhelpful messages',
        '6. Readability — naming, complexity, documentation',
        '',
        'For each finding:',
        '- Severity: important | nit | pre-existing',
        '- Category: logic-bug | security | edge-case | performance | error-handling | style',
        '- File and line (approximate)',
        '- Description',
        '- Suggested fix',
        '',
        'At the end, include this exact block:',
        '--- STAGE 2 VERDICT ---',
        'QUALITY_SCORE: <1-10>',
        'VERDICT: PASSED | REJECTED',
        'IMPORTANT_COUNT: <number>',
        'NIT_COUNT: <number>',
        'SUMMARY: <one-line summary>',
        '--- END VERDICT ---',
    ].join('\n');
}

/** Parse a stage verdict from AI output */
export function parseStageVerdict(aiOutput: string, stage: 1 | 2): StageResult {
    const stageName = stage === 1 ? 'Spec Compliance' : 'Code Quality';
    const label = `STAGE ${stage}`;

    const verdictBlock = aiOutput.match(
        new RegExp(`--- ${label} VERDICT ---\\s*\\n([\\s\\S]*?)--- END VERDICT ---`)
    );

    if (verdictBlock !== null) {
        const block = verdictBlock[1];
        const scoreMatch = block.match(/QUALITY_SCORE:\s*(\d+)/);
        const verdictMatch = block.match(/VERDICT:\s*(PASSED|REJECTED)/i);
        const importantMatch = block.match(/IMPORTANT_COUNT:\s*(\d+)/);
        const nitMatch = block.match(/NIT_COUNT:\s*(\d+)/);
        const summaryMatch = block.match(/SUMMARY:\s*(.+)/);

        const qualityScore = scoreMatch !== null ? parseInt(scoreMatch[1], 10) : 5;
        const passed = verdictMatch !== null
            ? verdictMatch[1].toUpperCase() === 'PASSED'
            : qualityScore >= 6;

        return {
            stage,
            stageName,
            passed,
            qualityScore: Math.min(10, Math.max(1, qualityScore)),
            findings: [],
            summary: summaryMatch !== null ? summaryMatch[1].trim() : `${stageName} review completed`,
        };
    }

    // Fallback: loose parsing
    const scoreMatch = aiOutput.match(/quality\s*score[:\s]*(\d+)/i);
    const qualityScore = scoreMatch !== null ? parseInt(scoreMatch[1], 10) : 5;

    return {
        stage,
        stageName,
        passed: qualityScore >= 6,
        qualityScore: Math.min(10, Math.max(1, qualityScore)),
        findings: [],
        summary: `${stageName} review completed (parsed from unstructured output)`,
    };
}

/** Determine if Stage 2 should be skipped based on Stage 1 results */
export function shouldSkipStage2(stage1: StageResult): boolean {
    return stage1.qualityScore < STAGE1_SKIP_THRESHOLD;
}

/** Combine both stage results into a final review result */
export function combineTwoStageResults(
    stage1: StageResult,
    stage2: StageResult | null
): TwoStageReviewResult {
    const allFindings = stage2 !== null
        ? [...stage1.findings, ...stage2.findings]
        : [...stage1.findings];

    const importantCount = allFindings.filter(f => f.severity === 'important').length;
    const nitCount = allFindings.filter(f => f.severity === 'nit').length;
    const preExistingCount = allFindings.filter(f => f.severity === 'pre-existing').length;

    const overallPassed = stage1.passed && (stage2 === null || stage2.passed);
    const overallScore = stage2 !== null
        ? Math.round((stage1.qualityScore + stage2.qualityScore) / 2)
        : stage1.qualityScore;

    return {
        stage1,
        stage2,
        overallPassed,
        overallScore,
        allFindings,
        importantCount,
        nitCount,
        preExistingCount,
    };
}
