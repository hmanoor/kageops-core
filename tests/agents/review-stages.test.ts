import { describe, it, expect } from 'vitest';
import {
    buildStage1Prompt,
    buildStage2Prompt,
    parseStageVerdict,
    shouldSkipStage2,
    combineTwoStageResults,
    type StageResult,
    type ReviewFinding,
} from '../../src/agents/review-stages';

describe('buildStage1Prompt', () => {
    it('includes task title and specification', () => {
        const prompt = buildStage1Prompt('Add login form', 'Must have email and password fields');
        expect(prompt).toContain('Add login form');
        expect(prompt).toContain('Must have email and password fields');
    });

    it('includes spec compliance keywords', () => {
        const prompt = buildStage1Prompt('Test', 'Desc');
        expect(prompt).toContain('SPECIFICATION COMPLIANCE');
        expect(prompt).toContain('STAGE 1');
        expect(prompt).toContain('spec-mismatch');
        expect(prompt).toContain('missing-requirement');
    });

    it('instructs not to review code quality', () => {
        const prompt = buildStage1Prompt('Test', 'Desc');
        expect(prompt).toContain('Do NOT review code quality');
    });
});

describe('buildStage2Prompt', () => {
    it('includes task title', () => {
        const prompt = buildStage2Prompt('Add login form');
        expect(prompt).toContain('Add login form');
    });

    it('includes code quality keywords', () => {
        const prompt = buildStage2Prompt('Test');
        expect(prompt).toContain('CODE QUALITY');
        expect(prompt).toContain('STAGE 2');
        expect(prompt).toContain('Logic bugs');
        expect(prompt).toContain('Security');
        expect(prompt).toContain('Performance');
    });
});

describe('parseStageVerdict', () => {
    it('parses structured stage 1 verdict', () => {
        const output = [
            'Some review text here.',
            '--- STAGE 1 VERDICT ---',
            'QUALITY_SCORE: 8',
            'VERDICT: PASSED',
            'IMPORTANT_COUNT: 1',
            'NIT_COUNT: 3',
            'SUMMARY: Spec mostly met with minor gaps',
            '--- END VERDICT ---',
        ].join('\n');

        const result = parseStageVerdict(output, 1);
        expect(result.stage).toBe(1);
        expect(result.stageName).toBe('Spec Compliance');
        expect(result.qualityScore).toBe(8);
        expect(result.passed).toBe(true);
        expect(result.summary).toBe('Spec mostly met with minor gaps');
    });

    it('parses structured stage 2 verdict', () => {
        const output = [
            'Code quality analysis...',
            '--- STAGE 2 VERDICT ---',
            'QUALITY_SCORE: 3',
            'VERDICT: REJECTED',
            'IMPORTANT_COUNT: 5',
            'NIT_COUNT: 2',
            'SUMMARY: Major security issues found',
            '--- END VERDICT ---',
        ].join('\n');

        const result = parseStageVerdict(output, 2);
        expect(result.stage).toBe(2);
        expect(result.stageName).toBe('Code Quality');
        expect(result.qualityScore).toBe(3);
        expect(result.passed).toBe(false);
        expect(result.summary).toBe('Major security issues found');
    });

    it('falls back to loose parsing when no verdict block', () => {
        const output = 'The quality score: 7 out of 10. Generally good code.';

        const result = parseStageVerdict(output, 1);
        expect(result.stage).toBe(1);
        expect(result.qualityScore).toBe(7);
        expect(result.passed).toBe(true);
        expect(result.summary).toContain('parsed from unstructured output');
    });

    it('defaults to score 5 when nothing parseable', () => {
        const result = parseStageVerdict('No structured data here.', 2);
        expect(result.qualityScore).toBe(5);
        expect(result.passed).toBe(false); // 5 < 6
    });

    it('clamps score to 1-10 range', () => {
        const output = [
            '--- STAGE 1 VERDICT ---',
            'QUALITY_SCORE: 15',
            'VERDICT: PASSED',
            'IMPORTANT_COUNT: 0',
            'NIT_COUNT: 0',
            'SUMMARY: Perfect',
            '--- END VERDICT ---',
        ].join('\n');

        const result = parseStageVerdict(output, 1);
        expect(result.qualityScore).toBe(10);
    });
});

describe('shouldSkipStage2', () => {
    it('returns true when stage 1 score < 4', () => {
        const stage1: StageResult = {
            stage: 1, stageName: 'Spec Compliance',
            passed: false, qualityScore: 3, findings: [], summary: 'Bad',
        };
        expect(shouldSkipStage2(stage1)).toBe(true);
    });

    it('returns false when stage 1 score >= 4', () => {
        const stage1: StageResult = {
            stage: 1, stageName: 'Spec Compliance',
            passed: false, qualityScore: 4, findings: [], summary: 'Ok',
        };
        expect(shouldSkipStage2(stage1)).toBe(false);
    });

    it('returns false when stage 1 score is high', () => {
        const stage1: StageResult = {
            stage: 1, stageName: 'Spec Compliance',
            passed: true, qualityScore: 9, findings: [], summary: 'Great',
        };
        expect(shouldSkipStage2(stage1)).toBe(false);
    });
});

describe('combineTwoStageResults', () => {
    const makeFindings = (severities: Array<'important' | 'nit' | 'pre-existing'>, stage: 1 | 2): readonly ReviewFinding[] =>
        severities.map(s => ({
            severity: s, file: 'test.ts', line: 1, category: 'test',
            description: 'desc', suggestedFix: 'fix', stage,
        }));

    it('combines both stages', () => {
        const stage1: StageResult = {
            stage: 1, stageName: 'Spec Compliance',
            passed: true, qualityScore: 8,
            findings: makeFindings(['nit'], 1), summary: 'Good',
        };
        const stage2: StageResult = {
            stage: 2, stageName: 'Code Quality',
            passed: true, qualityScore: 6,
            findings: makeFindings(['important', 'nit'], 2), summary: 'Decent',
        };

        const result = combineTwoStageResults(stage1, stage2);
        expect(result.overallPassed).toBe(true);
        expect(result.overallScore).toBe(7); // (8+6)/2
        expect(result.allFindings).toHaveLength(3);
        expect(result.importantCount).toBe(1);
        expect(result.nitCount).toBe(2);
        expect(result.preExistingCount).toBe(0);
    });

    it('handles stage2=null (skipped)', () => {
        const stage1: StageResult = {
            stage: 1, stageName: 'Spec Compliance',
            passed: false, qualityScore: 2,
            findings: makeFindings(['important', 'important', 'pre-existing'], 1),
            summary: 'Failed',
        };

        const result = combineTwoStageResults(stage1, null);
        expect(result.stage2).toBeNull();
        expect(result.overallPassed).toBe(false);
        expect(result.overallScore).toBe(2);
        expect(result.allFindings).toHaveLength(3);
        expect(result.importantCount).toBe(2);
        expect(result.preExistingCount).toBe(1);
    });

    it('fails overall if stage1 passes but stage2 fails', () => {
        const stage1: StageResult = {
            stage: 1, stageName: 'Spec Compliance',
            passed: true, qualityScore: 7, findings: [], summary: 'Ok',
        };
        const stage2: StageResult = {
            stage: 2, stageName: 'Code Quality',
            passed: false, qualityScore: 3, findings: [], summary: 'Bad',
        };

        const result = combineTwoStageResults(stage1, stage2);
        expect(result.overallPassed).toBe(false);
        expect(result.overallScore).toBe(5);
    });

    it('counts severities across both stages', () => {
        const stage1: StageResult = {
            stage: 1, stageName: 'Spec Compliance',
            passed: true, qualityScore: 7,
            findings: makeFindings(['important', 'nit', 'pre-existing'], 1),
            summary: 'Ok',
        };
        const stage2: StageResult = {
            stage: 2, stageName: 'Code Quality',
            passed: true, qualityScore: 7,
            findings: makeFindings(['important', 'pre-existing', 'pre-existing'], 2),
            summary: 'Ok',
        };

        const result = combineTwoStageResults(stage1, stage2);
        expect(result.importantCount).toBe(2);
        expect(result.nitCount).toBe(1);
        expect(result.preExistingCount).toBe(3);
    });
});
