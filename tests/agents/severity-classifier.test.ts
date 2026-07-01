import { describe, it, expect } from 'vitest';
import {
    buildClassificationPrompt,
    parseClassification,
    classifyBySeverityHeuristic,
    buildClassificationResult,
    formatClassifiedReport,
    ClassifiedFinding,
} from '../../src/agents/severity-classifier';

// ── Fixtures ─────────────────────────────────────────

const FINDING_A = {
    file: 'src/auth.ts',
    line: 42,
    severity: 'high',
    message: 'SQL injection risk',
};

const FINDING_B = {
    file: 'src/utils.ts',
    line: null,
    severity: 'low',
    message: 'Missing semicolon',
};

const CHANGED_FILES = ['src/auth.ts', 'src/main.ts'];

// ── buildClassificationPrompt ────────────────────────

describe('buildClassificationPrompt', () => {
    it('includes all findings in the prompt', () => {
        const prompt = buildClassificationPrompt([FINDING_A, FINDING_B], CHANGED_FILES);
        expect(prompt).toContain('src/auth.ts');
        expect(prompt).toContain('SQL injection risk');
        expect(prompt).toContain('src/utils.ts');
        expect(prompt).toContain('Missing semicolon');
    });

    it('includes changed files list in the prompt', () => {
        const prompt = buildClassificationPrompt([FINDING_A], CHANGED_FILES);
        expect(prompt).toContain('src/auth.ts');
        expect(prompt).toContain('src/main.ts');
    });

    it('handles empty changed files list', () => {
        const prompt = buildClassificationPrompt([FINDING_A], []);
        expect(prompt).toContain('(none)');
    });

    it('includes severity values', () => {
        const prompt = buildClassificationPrompt([FINDING_A], CHANGED_FILES);
        expect(prompt).toContain('high');
    });
});

// ── parseClassification ──────────────────────────────

describe('parseClassification', () => {
    it('parses a structured classified block correctly', () => {
        const output = [
            '--- CLASSIFIED ---',
            'FILE: src/auth.ts',
            'LINE: 42',
            'CLASS: important',
            'ORIGINAL_SEVERITY: high',
            'MESSAGE: SQL injection risk',
            'REASONING: Introduced in this change and could cause data exposure',
            '--- END CLASSIFIED ---',
        ].join('\n');

        const findings = parseClassification(output);
        expect(findings).toHaveLength(1);
        expect(findings[0].file).toBe('src/auth.ts');
        expect(findings[0].line).toBe(42);
        expect(findings[0].severityClass).toBe('important');
        expect(findings[0].originalSeverity).toBe('high');
        expect(findings[0].message).toBe('SQL injection risk');
        expect(findings[0].reasoning).toContain('Introduced');
    });

    it('parses multiple structured blocks', () => {
        const output = [
            '--- CLASSIFIED ---',
            'FILE: src/auth.ts',
            'LINE: 42',
            'CLASS: important',
            'ORIGINAL_SEVERITY: high',
            'MESSAGE: First issue',
            'REASONING: New critical bug',
            '--- END CLASSIFIED ---',
            '--- CLASSIFIED ---',
            'FILE: src/utils.ts',
            'LINE: null',
            'CLASS: nit',
            'ORIGINAL_SEVERITY: low',
            'MESSAGE: Style issue',
            'REASONING: Minor style concern',
            '--- END CLASSIFIED ---',
        ].join('\n');

        const findings = parseClassification(output);
        expect(findings).toHaveLength(2);
        expect(findings[0].severityClass).toBe('important');
        expect(findings[1].severityClass).toBe('nit');
    });

    it('parses null line numbers correctly', () => {
        const output = [
            '--- CLASSIFIED ---',
            'FILE: src/utils.ts',
            'LINE: null',
            'CLASS: nit',
            'ORIGINAL_SEVERITY: low',
            'MESSAGE: Missing type',
            'REASONING: Minor issue',
            '--- END CLASSIFIED ---',
        ].join('\n');

        const findings = parseClassification(output);
        expect(findings[0].line).toBeNull();
    });

    it('handles malformed / empty input gracefully', () => {
        expect(parseClassification('')).toHaveLength(0);
        expect(parseClassification('some random text without blocks')).toHaveLength(0);
    });

    it('handles partial / incomplete block gracefully', () => {
        const output = '--- CLASSIFIED ---\nFILE: src/foo.ts\nLINE: 1';
        // No crash, returns 0 or partial — should not throw
        expect(() => parseClassification(output)).not.toThrow();
    });
});

// ── classifyBySeverityHeuristic ──────────────────────

describe('classifyBySeverityHeuristic', () => {
    it('returns pre-existing for files not in changedFiles', () => {
        const result = classifyBySeverityHeuristic(
            { file: 'src/old.ts', severity: 'high' },
            CHANGED_FILES,
        );
        expect(result).toBe('pre-existing');
    });

    it('returns important for critical severity on changed file', () => {
        const result = classifyBySeverityHeuristic(
            { file: 'src/auth.ts', severity: 'critical' },
            CHANGED_FILES,
        );
        expect(result).toBe('important');
    });

    it('returns important for high severity on changed file', () => {
        const result = classifyBySeverityHeuristic(
            { file: 'src/auth.ts', severity: 'high' },
            CHANGED_FILES,
        );
        expect(result).toBe('important');
    });

    it('returns nit for medium severity on changed file', () => {
        const result = classifyBySeverityHeuristic(
            { file: 'src/auth.ts', severity: 'medium' },
            CHANGED_FILES,
        );
        expect(result).toBe('nit');
    });

    it('returns nit for low severity on changed file', () => {
        const result = classifyBySeverityHeuristic(
            { file: 'src/auth.ts', severity: 'low' },
            CHANGED_FILES,
        );
        expect(result).toBe('nit');
    });

    it('is case-insensitive for severity', () => {
        expect(classifyBySeverityHeuristic({ file: 'src/auth.ts', severity: 'CRITICAL' }, CHANGED_FILES)).toBe('important');
        expect(classifyBySeverityHeuristic({ file: 'src/auth.ts', severity: 'HIGH' }, CHANGED_FILES)).toBe('important');
    });
});

// ── buildClassificationResult ────────────────────────

const makeClassified = (
    cls: 'important' | 'nit' | 'pre-existing',
    file = 'src/f.ts',
): ClassifiedFinding => ({
    severityClass: cls,
    originalSeverity: 'high',
    file,
    line: 1,
    message: 'test message',
    reasoning: 'test reasoning',
});

describe('buildClassificationResult', () => {
    it('counts each class correctly', () => {
        const findings = [
            makeClassified('important'),
            makeClassified('important'),
            makeClassified('nit'),
            makeClassified('pre-existing'),
            makeClassified('pre-existing'),
            makeClassified('pre-existing'),
        ];
        const result = buildClassificationResult(findings);
        expect(result.importantCount).toBe(2);
        expect(result.nitCount).toBe(1);
        expect(result.preExistingCount).toBe(3);
    });

    it('sets blockRelease true when important count > 0', () => {
        const findings = [makeClassified('important'), makeClassified('nit')];
        const result = buildClassificationResult(findings);
        expect(result.blockRelease).toBe(true);
    });

    it('sets blockRelease false when no important findings', () => {
        const findings = [makeClassified('nit'), makeClassified('pre-existing')];
        const result = buildClassificationResult(findings);
        expect(result.blockRelease).toBe(false);
    });

    it('sets blockRelease false for empty findings', () => {
        const result = buildClassificationResult([]);
        expect(result.blockRelease).toBe(false);
        expect(result.importantCount).toBe(0);
    });

    it('preserves findings array', () => {
        const findings = [makeClassified('nit')];
        const result = buildClassificationResult(findings);
        expect(result.findings).toHaveLength(1);
    });
});

// ── formatClassifiedReport ───────────────────────────

describe('formatClassifiedReport', () => {
    it('includes all three sections', () => {
        const result = buildClassificationResult([
            makeClassified('important'),
            makeClassified('nit'),
            makeClassified('pre-existing'),
        ]);
        const report = formatClassifiedReport(result);
        expect(report).toContain('Important');
        expect(report).toContain('Nit');
        expect(report).toContain('Pre-existing');
    });

    it('shows BLOCKED when blockRelease is true', () => {
        const result = buildClassificationResult([makeClassified('important')]);
        const report = formatClassifiedReport(result);
        expect(report).toContain('BLOCKED');
    });

    it('shows PASSED when blockRelease is false', () => {
        const result = buildClassificationResult([makeClassified('nit')]);
        const report = formatClassifiedReport(result);
        expect(report).toContain('PASSED');
    });

    it('shows counts in section headers', () => {
        const result = buildClassificationResult([
            makeClassified('important'),
            makeClassified('important'),
            makeClassified('nit'),
        ]);
        const report = formatClassifiedReport(result);
        expect(report).toContain('Important (2)');
        expect(report).toContain('Nit (1)');
        expect(report).toContain('Pre-existing (0)');
    });

    it('includes finding messages in the report', () => {
        const findings: readonly ClassifiedFinding[] = [{
            severityClass: 'important',
            originalSeverity: 'critical',
            file: 'src/auth.ts',
            line: 10,
            message: 'Dangerous SQL query',
            reasoning: 'Could cause injection',
        }];
        const result = buildClassificationResult(findings);
        const report = formatClassifiedReport(result);
        expect(report).toContain('src/auth.ts');
        expect(report).toContain('Dangerous SQL query');
    });

    it('includes emoji indicators', () => {
        const result = buildClassificationResult([
            makeClassified('important'),
            makeClassified('nit'),
            makeClassified('pre-existing'),
        ]);
        const report = formatClassifiedReport(result);
        expect(report).toContain('🔴');
        expect(report).toContain('🟡');
        expect(report).toContain('🟣');
    });
});
