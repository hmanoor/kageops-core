import { describe, it, expect } from 'vitest';
import {
    buildFleetPrompt,
    parseFleetFindings,
    deduplicateFindings,
    rankFindings,
    buildFleetResult,
    DEFAULT_FLEET_ROLES,
    type FleetFinding,
    type ReviewerRole,
} from '../../src/agents/review-fleet';

// ── buildFleetPrompt ──────────────────────────────────

describe('buildFleetPrompt', () => {
    it('returns role-specific content for logic-bugs', () => {
        const prompt = buildFleetPrompt('logic-bugs', 'Add login', 'const x = 1;');
        expect(prompt).toContain('logic-bugs'.toUpperCase());
        expect(prompt).toContain('Off-by-one');
        expect(prompt).toContain('Race conditions');
        expect(prompt).toContain('Add login');
        expect(prompt).toContain('const x = 1;');
    });

    it('returns role-specific content for security', () => {
        const prompt = buildFleetPrompt('security', 'Auth module', 'code here');
        expect(prompt).toContain('SECURITY');
        expect(prompt).toContain('Injection');
        expect(prompt).toContain('XSS');
        expect(prompt).toContain('Path traversal');
    });

    it('returns role-specific content for edge-cases', () => {
        const prompt = buildFleetPrompt('edge-cases', 'Parser', 'code');
        expect(prompt).toContain('EDGE-CASES');
        expect(prompt).toContain('Empty inputs');
        expect(prompt).toContain('Boundary values');
        expect(prompt).toContain('Unicode');
    });

    it('returns role-specific content for regression', () => {
        const prompt = buildFleetPrompt('regression', 'Refactor API', 'code');
        expect(prompt).toContain('REGRESSION');
        expect(prompt).toContain('Breaking changes');
        expect(prompt).toContain('API contract');
    });

    it('returns role-specific content for performance', () => {
        const prompt = buildFleetPrompt('performance', 'Query optimizer', 'code');
        expect(prompt).toContain('PERFORMANCE');
        expect(prompt).toContain('O(n²)');
        expect(prompt).toContain('Memory leaks');
        expect(prompt).toContain('Blocking I/O');
    });

    it('includes structured finding format instructions', () => {
        const prompt = buildFleetPrompt('security', 'Task', 'code');
        expect(prompt).toContain('--- FINDING ---');
        expect(prompt).toContain('--- END FINDING ---');
        expect(prompt).toContain('FILE:');
        expect(prompt).toContain('SEVERITY:');
        expect(prompt).toContain('MESSAGE:');
        expect(prompt).toContain('SUGGESTION:');
    });
});

// ── parseFleetFindings ────────────────────────────────

describe('parseFleetFindings', () => {
    it('parses a single structured finding block', () => {
        const output = [
            'Some analysis...',
            '--- FINDING ---',
            'FILE: src/auth.ts',
            'LINE: 42',
            'SEVERITY: high',
            'MESSAGE: SQL query built with string concatenation',
            'SUGGESTION: Use parameterized queries',
            '--- END FINDING ---',
        ].join('\n');

        const findings = parseFleetFindings(output, 'security');
        expect(findings).toHaveLength(1);
        expect(findings[0].file).toBe('src/auth.ts');
        expect(findings[0].line).toBe(42);
        expect(findings[0].severity).toBe('high');
        expect(findings[0].message).toBe('SQL query built with string concatenation');
        expect(findings[0].suggestion).toBe('Use parameterized queries');
        expect(findings[0].role).toBe('security');
    });

    it('parses multiple structured finding blocks', () => {
        const output = [
            '--- FINDING ---',
            'FILE: a.ts',
            'LINE: 10',
            'SEVERITY: critical',
            'MESSAGE: Null dereference',
            'SUGGESTION: Add null check',
            '--- END FINDING ---',
            '--- FINDING ---',
            'FILE: b.ts',
            'LINE: 20',
            'SEVERITY: low',
            'MESSAGE: Minor style issue',
            'SUGGESTION: Rename variable',
            '--- END FINDING ---',
        ].join('\n');

        const findings = parseFleetFindings(output, 'logic-bugs');
        expect(findings).toHaveLength(2);
        expect(findings[0].severity).toBe('critical');
        expect(findings[1].severity).toBe('low');
    });

    it('handles malformed input gracefully (no crash)', () => {
        const findings = parseFleetFindings('completely random garbage $$$ !!!', 'performance');
        // Should not throw — returns empty or loose-parsed results
        expect(Array.isArray(findings)).toBe(true);
    });

    it('returns empty array for explicit NO FINDINGS signal', () => {
        const findings = parseFleetFindings('NO FINDINGS', 'edge-cases');
        expect(findings).toHaveLength(0);
    });

    it('handles UNKNOWN line number', () => {
        const output = [
            '--- FINDING ---',
            'FILE: src/utils.ts',
            'LINE: UNKNOWN',
            'SEVERITY: medium',
            'MESSAGE: Potential issue here',
            'SUGGESTION: Review carefully',
            '--- END FINDING ---',
        ].join('\n');

        const findings = parseFleetFindings(output, 'regression');
        expect(findings).toHaveLength(1);
        expect(findings[0].line).toBeNull();
    });

    it('generates deterministic IDs for identical file+line+message', () => {
        const block = [
            '--- FINDING ---',
            'FILE: src/foo.ts',
            'LINE: 5',
            'SEVERITY: high',
            'MESSAGE: Some issue',
            'SUGGESTION: Fix it',
            '--- END FINDING ---',
        ].join('\n');

        const findings1 = parseFleetFindings(block, 'security');
        const findings2 = parseFleetFindings(block, 'security');
        expect(findings1[0].id).toBe(findings2[0].id);
    });

    it('generates different IDs for different file+line+message', () => {
        const blockA = [
            '--- FINDING ---',
            'FILE: src/a.ts',
            'LINE: 1',
            'SEVERITY: high',
            'MESSAGE: Issue A',
            'SUGGESTION: Fix A',
            '--- END FINDING ---',
        ].join('\n');

        const blockB = [
            '--- FINDING ---',
            'FILE: src/b.ts',
            'LINE: 2',
            'SEVERITY: high',
            'MESSAGE: Issue B',
            'SUGGESTION: Fix B',
            '--- END FINDING ---',
        ].join('\n');

        const findingA = parseFleetFindings(blockA, 'security');
        const findingB = parseFleetFindings(blockB, 'security');
        expect(findingA[0].id).not.toBe(findingB[0].id);
    });
});

// ── deduplicateFindings ───────────────────────────────

describe('deduplicateFindings', () => {
    const makeFinding = (
        id: string,
        severity: FleetFinding['severity'],
        role: ReviewerRole = 'security'
    ): FleetFinding => ({
        id,
        role,
        file: 'src/test.ts',
        line: 1,
        severity,
        message: `Message for ${id}`,
        suggestion: '',
    });

    it('returns all findings when no duplicates', () => {
        const findings = [
            makeFinding('aaa', 'high'),
            makeFinding('bbb', 'medium'),
            makeFinding('ccc', 'low'),
        ];
        const result = deduplicateFindings(findings);
        expect(result).toHaveLength(3);
    });

    it('removes duplicate IDs, keeping highest severity', () => {
        const findings = [
            makeFinding('abc', 'low'),
            makeFinding('abc', 'critical'),
            makeFinding('abc', 'medium'),
        ];
        const result = deduplicateFindings(findings);
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('critical');
    });

    it('keeps lower severity when already highest', () => {
        const findings = [
            makeFinding('xyz', 'critical'),
            makeFinding('xyz', 'high'),
        ];
        const result = deduplicateFindings(findings);
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('critical');
    });

    it('handles empty input', () => {
        expect(deduplicateFindings([])).toHaveLength(0);
    });

    it('handles single finding', () => {
        const findings = [makeFinding('solo', 'medium')];
        const result = deduplicateFindings(findings);
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('medium');
    });

    it('does not mutate the input array', () => {
        const findings = [
            makeFinding('dup', 'high'),
            makeFinding('dup', 'critical'),
        ];
        const original = [...findings];
        deduplicateFindings(findings);
        expect(findings).toHaveLength(original.length);
    });
});

// ── rankFindings ──────────────────────────────────────

describe('rankFindings', () => {
    const makeFinding = (
        severity: FleetFinding['severity'],
        file: string,
        line: number | null
    ): FleetFinding => ({
        id: `${severity}-${file}-${line}`,
        role: 'logic-bugs',
        file,
        line,
        severity,
        message: 'Some issue',
        suggestion: '',
    });

    it('sorts critical before high before medium before low', () => {
        const findings = [
            makeFinding('low', 'a.ts', 1),
            makeFinding('critical', 'a.ts', 2),
            makeFinding('medium', 'a.ts', 3),
            makeFinding('high', 'a.ts', 4),
        ];
        const ranked = rankFindings(findings);
        expect(ranked[0].severity).toBe('critical');
        expect(ranked[1].severity).toBe('high');
        expect(ranked[2].severity).toBe('medium');
        expect(ranked[3].severity).toBe('low');
    });

    it('sorts by file name for same severity', () => {
        const findings = [
            makeFinding('high', 'z.ts', 1),
            makeFinding('high', 'a.ts', 1),
            makeFinding('high', 'm.ts', 1),
        ];
        const ranked = rankFindings(findings);
        expect(ranked[0].file).toBe('a.ts');
        expect(ranked[1].file).toBe('m.ts');
        expect(ranked[2].file).toBe('z.ts');
    });

    it('sorts by line number for same severity and file', () => {
        const findings = [
            makeFinding('medium', 'src/foo.ts', 30),
            makeFinding('medium', 'src/foo.ts', 5),
            makeFinding('medium', 'src/foo.ts', 15),
        ];
        const ranked = rankFindings(findings);
        expect(ranked[0].line).toBe(5);
        expect(ranked[1].line).toBe(15);
        expect(ranked[2].line).toBe(30);
    });

    it('places null lines after numbered lines', () => {
        const findings = [
            makeFinding('high', 'a.ts', null),
            makeFinding('high', 'a.ts', 1),
        ];
        const ranked = rankFindings(findings);
        expect(ranked[0].line).toBe(1);
        expect(ranked[1].line).toBeNull();
    });

    it('does not mutate input array', () => {
        const findings = [
            makeFinding('low', 'z.ts', 1),
            makeFinding('critical', 'a.ts', 1),
        ];
        const original = [...findings];
        rankFindings(findings);
        expect(findings[0].severity).toBe(original[0].severity);
        expect(findings[1].severity).toBe(original[1].severity);
    });
});

// ── buildFleetResult ──────────────────────────────────

describe('buildFleetResult', () => {
    const makeFinding = (
        role: ReviewerRole,
        severity: FleetFinding['severity']
    ): FleetFinding => ({
        id: `${role}-${severity}-${Math.random()}`,
        role,
        file: 'src/test.ts',
        line: 1,
        severity,
        message: 'Issue',
        suggestion: 'Fix',
    });

    it('aggregates counts by role', () => {
        const findings = [
            makeFinding('security', 'critical'),
            makeFinding('security', 'high'),
            makeFinding('logic-bugs', 'medium'),
            makeFinding('performance', 'low'),
        ];
        const result = buildFleetResult(findings, 6);
        expect(result.totalByRole['security']).toBe(2);
        expect(result.totalByRole['logic-bugs']).toBe(1);
        expect(result.totalByRole['performance']).toBe(1);
        expect(result.totalByRole['edge-cases']).toBe(0);
        expect(result.totalByRole['regression']).toBe(0);
    });

    it('aggregates counts by severity', () => {
        const findings = [
            makeFinding('security', 'critical'),
            makeFinding('logic-bugs', 'critical'),
            makeFinding('edge-cases', 'medium'),
        ];
        const result = buildFleetResult(findings, 5);
        expect(result.totalBySeverity['critical']).toBe(2);
        expect(result.totalBySeverity['medium']).toBe(1);
    });

    it('sets deduplicatedCount to findings length', () => {
        const findings = [
            makeFinding('security', 'high'),
            makeFinding('regression', 'low'),
        ];
        const result = buildFleetResult(findings, 10);
        expect(result.deduplicatedCount).toBe(2);
        expect(result.originalCount).toBe(10);
    });

    it('handles empty findings array', () => {
        const result = buildFleetResult([], 0);
        expect(result.findings).toHaveLength(0);
        expect(result.deduplicatedCount).toBe(0);
        expect(result.originalCount).toBe(0);
        expect(result.totalByRole['security']).toBe(0);
    });

    it('preserves the findings reference', () => {
        const findings = [makeFinding('security', 'high')];
        const result = buildFleetResult(findings, 1);
        expect(result.findings).toBe(findings);
    });
});

// ── DEFAULT_FLEET_ROLES ───────────────────────────────

describe('DEFAULT_FLEET_ROLES', () => {
    it('contains all 5 expected roles', () => {
        expect(DEFAULT_FLEET_ROLES).toHaveLength(5);
        expect(DEFAULT_FLEET_ROLES).toContain('logic-bugs');
        expect(DEFAULT_FLEET_ROLES).toContain('security');
        expect(DEFAULT_FLEET_ROLES).toContain('edge-cases');
        expect(DEFAULT_FLEET_ROLES).toContain('regression');
        expect(DEFAULT_FLEET_ROLES).toContain('performance');
    });
});
