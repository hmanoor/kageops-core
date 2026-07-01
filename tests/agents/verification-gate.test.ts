import { describe, it, expect } from 'vitest';
import {
    getRequiredChecks,
    evaluateVerification,
    evidenceFromShell,
    evidenceFromFiles,
    evidenceFromReview,
    VerificationEvidence,
    VerificationKind,
} from '../../src/agents/verification-gate';

describe('verification-gate', () => {

    // ── getRequiredChecks ────────────────────────────

    describe('getRequiredChecks', () => {
        it('returns correct checks for known task types', () => {
            expect(getRequiredChecks('implement')).toEqual(['files_written', 'build_succeeded']);
            expect(getRequiredChecks('fix-bug')).toEqual(['files_written', 'tests_passed']);
            expect(getRequiredChecks('code-review')).toEqual(['review_completed']);
            expect(getRequiredChecks('quality-gate')).toEqual(['build_succeeded', 'tests_passed', 'linter_clean']);
            expect(getRequiredChecks('run-tests')).toEqual(['tests_passed']);
            expect(getRequiredChecks('documentation')).toEqual(['files_written']);
        });

        it('returns default checks for unknown task types', () => {
            expect(getRequiredChecks('unknown-type')).toEqual(['files_written']);
            expect(getRequiredChecks('')).toEqual(['files_written']);
        });

        it('every known task type has at least one required check', () => {
            const knownTypes = [
                'implement', 'fix-bug', 'refactor', 'create-api', 'create-ui',
                'database-migration', 'write-tests', 'code-review', 'security-review',
                'quality-gate', 'run-tests', 'documentation',
            ];
            for (const taskType of knownTypes) {
                expect(getRequiredChecks(taskType).length).toBeGreaterThan(0);
            }
        });
    });

    // ── evaluateVerification ─────────────────────────

    describe('evaluateVerification', () => {
        it('returns verified=true when all required evidence passes', () => {
            const evidence: VerificationEvidence[] = [
                makeEvidence('files_written', true),
                makeEvidence('build_succeeded', true),
            ];
            const result = evaluateVerification('implement', evidence);
            expect(result.verified).toBe(true);
            expect(result.missingChecks).toEqual([]);
            expect(result.summary).toContain('Verified');
        });

        it('returns verified=false when evidence is missing', () => {
            const evidence: VerificationEvidence[] = [
                makeEvidence('files_written', true),
            ];
            const result = evaluateVerification('implement', evidence);
            expect(result.verified).toBe(false);
            expect(result.missingChecks).toEqual(['build_succeeded']);
            expect(result.summary).toContain('missing');
        });

        it('returns verified=false when evidence exists but failed', () => {
            const evidence: VerificationEvidence[] = [
                makeEvidence('files_written', true),
                makeEvidence('build_succeeded', false),
            ];
            const result = evaluateVerification('implement', evidence);
            expect(result.verified).toBe(false);
            expect(result.missingChecks).toEqual(['build_succeeded']);
        });

        it('returns verified=false when no evidence provided', () => {
            const result = evaluateVerification('implement', []);
            expect(result.verified).toBe(false);
        });

        it('handles extra evidence beyond what is required', () => {
            const evidence: VerificationEvidence[] = [
                makeEvidence('files_written', true),
                makeEvidence('build_succeeded', true),
                makeEvidence('tests_passed', true),
            ];
            const result = evaluateVerification('implement', evidence);
            expect(result.verified).toBe(true);
            expect(result.evidence).toHaveLength(3);
        });

        it('handles unknown task type with default checks', () => {
            const evidence: VerificationEvidence[] = [
                makeEvidence('files_written', true),
            ];
            const result = evaluateVerification('some-random-type', evidence);
            expect(result.verified).toBe(true);
        });
    });

    // ── evidenceFromShell ────────────────────────────

    describe('evidenceFromShell', () => {
        it('creates passing evidence for exit code 0', () => {
            const ev = evidenceFromShell('build_succeeded', 'Build OK', 'compiled', '', 0);
            expect(ev.kind).toBe('build_succeeded');
            expect(ev.passed).toBe(true);
            expect(ev.output).toBe('compiled');
            expect(ev.timestamp).toBeInstanceOf(Date);
        });

        it('creates failing evidence for non-zero exit code', () => {
            const ev = evidenceFromShell('tests_passed', 'Tests failed', '', 'FAIL 2 tests', 1);
            expect(ev.passed).toBe(false);
            expect(ev.output).toBe('FAIL 2 tests');
        });

        it('truncates output to 2000 chars', () => {
            const longOutput = 'x'.repeat(3000);
            const ev = evidenceFromShell('build_succeeded', 'Build', longOutput, '', 0);
            expect(ev.output.length).toBe(2000);
        });
    });

    // ── evidenceFromFiles ────────────────────────────

    describe('evidenceFromFiles', () => {
        it('creates passing evidence for non-empty file list', () => {
            const ev = evidenceFromFiles(['src/a.ts', 'src/b.ts']);
            expect(ev.kind).toBe('files_written');
            expect(ev.passed).toBe(true);
            expect(ev.summary).toBe('2 file(s) written');
            expect(ev.output).toBe('src/a.ts\nsrc/b.ts');
        });

        it('creates failing evidence for empty file list', () => {
            const ev = evidenceFromFiles([]);
            expect(ev.passed).toBe(false);
            expect(ev.summary).toBe('0 file(s) written');
        });
    });

    // ── evidenceFromReview ───────────────────────────

    describe('evidenceFromReview', () => {
        it('creates passing evidence for approved review', () => {
            const ev = evidenceFromReview(8, true, 'Code looks good');
            expect(ev.kind).toBe('review_completed');
            expect(ev.passed).toBe(true);
            expect(ev.output).toContain('PASSED');
            expect(ev.output).toContain('8/10');
        });

        it('creates failing evidence for rejected review', () => {
            const ev = evidenceFromReview(3, false, 'Critical issues');
            expect(ev.passed).toBe(false);
            expect(ev.output).toContain('REJECTED');
            expect(ev.output).toContain('3/10');
        });
    });
});

// ── Helpers ──────────────────────────────────────

function makeEvidence(kind: VerificationKind, passed: boolean): VerificationEvidence {
    return {
        kind,
        summary: `${kind} check`,
        output: passed ? 'OK' : 'FAIL',
        passed,
        timestamp: new Date(),
    };
}
