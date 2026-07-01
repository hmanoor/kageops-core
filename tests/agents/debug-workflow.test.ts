import { describe, it, expect } from 'vitest';
import {
    ALL_PHASES,
    createInitialState,
    buildInvestigationPrompt,
    buildEvidenceGatheringPrompt,
    buildHypothesisPrompt,
    buildVerificationPrompt,
    parseEvidence,
    parseHypotheses,
    advancePhase,
    formatDebugReport,
    type DebugEvidence,
    type DebugHypothesis,
    type DebugState,
} from '../../src/agents/debug-workflow';

describe('ALL_PHASES', () => {
    it('has 4 phases in order', () => {
        expect(ALL_PHASES).toEqual(['investigation', 'evidence', 'hypothesis', 'verification']);
    });
});

describe('createInitialState', () => {
    it('starts in investigation phase', () => {
        const state = createInitialState('Button click crashes app');
        expect(state.phase).toBe('investigation');
    });

    it('has empty evidence and hypotheses', () => {
        const state = createInitialState('Button click crashes app');
        expect(state.evidence).toHaveLength(0);
        expect(state.hypotheses).toHaveLength(0);
    });

    it('stores the bug description', () => {
        const desc = 'Login fails with 500 error';
        const state = createInitialState(desc);
        expect(state.bugDescription).toBe(desc);
    });

    it('has null rootCause, fix and verified false', () => {
        const state = createInitialState('some bug');
        expect(state.rootCause).toBeNull();
        expect(state.fix).toBeNull();
        expect(state.verified).toBe(false);
    });
});

describe('buildInvestigationPrompt', () => {
    it('includes the bug description', () => {
        const prompt = buildInvestigationPrompt('NPE in UserService');
        expect(prompt).toContain('NPE in UserService');
    });

    it('includes "Do NOT try to fix"', () => {
        const prompt = buildInvestigationPrompt('some bug');
        expect(prompt).toContain('Do NOT try to fix');
    });

    it('mentions EVIDENCE output format', () => {
        const prompt = buildInvestigationPrompt('some bug');
        expect(prompt).toContain('EVIDENCE:');
    });
});

describe('buildEvidenceGatheringPrompt', () => {
    it('includes the bug description', () => {
        const prompt = buildEvidenceGatheringPrompt('DB timeout', []);
        expect(prompt).toContain('DB timeout');
    });

    it('includes existing evidence', () => {
        const evidence: readonly DebugEvidence[] = [
            { type: 'observation', description: 'slow query', data: 'SELECT * takes 30s' },
        ];
        const prompt = buildEvidenceGatheringPrompt('DB timeout', evidence);
        expect(prompt).toContain('slow query');
        expect(prompt).toContain('SELECT * takes 30s');
    });

    it('shows (none) when no evidence provided', () => {
        const prompt = buildEvidenceGatheringPrompt('DB timeout', []);
        expect(prompt).toContain('(none)');
    });
});

describe('buildHypothesisPrompt', () => {
    it('includes the bug description', () => {
        const prompt = buildHypothesisPrompt('Memory leak', []);
        expect(prompt).toContain('Memory leak');
    });

    it('asks for likelihood ranking', () => {
        const prompt = buildHypothesisPrompt('Memory leak', []);
        expect(prompt).toContain('LIKELIHOOD:');
        expect(prompt).toContain('high|medium|low');
    });

    it('asks for a test plan per hypothesis', () => {
        const prompt = buildHypothesisPrompt('Memory leak', []);
        expect(prompt).toContain('TEST:');
    });
});

describe('buildVerificationPrompt', () => {
    it('includes the bug description', () => {
        const prompt = buildVerificationPrompt('Crash on submit', 'null ref', 'add null check');
        expect(prompt).toContain('Crash on submit');
    });

    it('includes root cause', () => {
        const prompt = buildVerificationPrompt('Crash', 'null ref in handler', 'add guard');
        expect(prompt).toContain('null ref in handler');
    });

    it('includes the fix', () => {
        const prompt = buildVerificationPrompt('Crash', 'null ref', 'add null check before access');
        expect(prompt).toContain('add null check before access');
    });
});

describe('parseEvidence', () => {
    it('parses structured blocks', () => {
        const output = [
            'EVIDENCE: error-log',
            'DESCRIPTION: Console error on load',
            'DATA: TypeError: Cannot read property x of undefined',
            'END EVIDENCE',
        ].join('\n');

        const results = parseEvidence(output);
        expect(results).toHaveLength(1);
        expect(results[0].type).toBe('error-log');
        expect(results[0].description).toBe('Console error on load');
        expect(results[0].data).toBe('TypeError: Cannot read property x of undefined');
    });

    it('handles empty input', () => {
        expect(parseEvidence('')).toHaveLength(0);
        expect(parseEvidence('no blocks here')).toHaveLength(0);
    });

    it('parses multiple blocks', () => {
        const output = [
            'EVIDENCE: observation',
            'DESCRIPTION: First finding',
            'DATA: data1',
            'END EVIDENCE',
            'EVIDENCE: stack-trace',
            'DESCRIPTION: Stack trace found',
            'DATA: at line 42',
            'END EVIDENCE',
        ].join('\n');

        const results = parseEvidence(output);
        expect(results).toHaveLength(2);
        expect(results[0].type).toBe('observation');
        expect(results[1].type).toBe('stack-trace');
    });

    it('defaults unknown type to observation', () => {
        const output = [
            'EVIDENCE: unknown-type',
            'DESCRIPTION: Something',
            'DATA: data',
            'END EVIDENCE',
        ].join('\n');

        const results = parseEvidence(output);
        expect(results[0].type).toBe('observation');
    });
});

describe('parseHypotheses', () => {
    it('parses hypothesis blocks with likelihood', () => {
        const output = [
            'HYPOTHESIS: Race condition in event handler',
            'LIKELIHOOD: high',
            'TEST: Add logging around the event handler and trigger multiple rapid clicks',
            'END HYPOTHESIS',
        ].join('\n');

        const results = parseHypotheses(output);
        expect(results).toHaveLength(1);
        expect(results[0].description).toBe('Race condition in event handler');
        expect(results[0].likelihood).toBe('high');
        expect(results[0].testPlan).toBe('Add logging around the event handler and trigger multiple rapid clicks');
        expect(results[0].disproved).toBe(false);
    });

    it('handles empty input', () => {
        expect(parseHypotheses('')).toHaveLength(0);
        expect(parseHypotheses('no blocks')).toHaveLength(0);
    });

    it('assigns sequential ids starting at 1', () => {
        const output = [
            'HYPOTHESIS: First',
            'LIKELIHOOD: high',
            'TEST: test1',
            'END HYPOTHESIS',
            'HYPOTHESIS: Second',
            'LIKELIHOOD: low',
            'TEST: test2',
            'END HYPOTHESIS',
        ].join('\n');

        const results = parseHypotheses(output);
        expect(results[0].id).toBe(1);
        expect(results[1].id).toBe(2);
    });

    it('defaults unknown likelihood to low', () => {
        const output = [
            'HYPOTHESIS: Something',
            'LIKELIHOOD: maybe',
            'TEST: try it',
            'END HYPOTHESIS',
        ].join('\n');

        const results = parseHypotheses(output);
        expect(results[0].likelihood).toBe('low');
    });
});

describe('advancePhase', () => {
    it('moves to next phase immutably', () => {
        const state = createInitialState('bug');
        const next = advancePhase(state);
        expect(next.phase).toBe('evidence');
        expect(state.phase).toBe('investigation'); // original unchanged
    });

    it('merges new evidence', () => {
        const state = createInitialState('bug');
        const ev: DebugEvidence = { type: 'observation', description: 'found it', data: 'data' };
        const next = advancePhase(state, [ev]);
        expect(next.evidence).toHaveLength(1);
        expect(next.evidence[0]).toBe(ev);
    });

    it('merges new hypotheses', () => {
        const state: DebugState = {
            ...createInitialState('bug'),
            phase: 'evidence',
        };
        const hyp: DebugHypothesis = {
            id: 1,
            description: 'bad pointer',
            likelihood: 'high',
            testPlan: 'check pointer',
            disproved: false,
        };
        const next = advancePhase(state, undefined, [hyp]);
        expect(next.hypotheses).toHaveLength(1);
        expect(next.hypotheses[0]).toBe(hyp);
    });

    it('sets rootCause and fix', () => {
        const state: DebugState = {
            ...createInitialState('bug'),
            phase: 'hypothesis',
        };
        const next = advancePhase(state, undefined, undefined, 'null pointer', 'add guard');
        expect(next.rootCause).toBe('null pointer');
        expect(next.fix).toBe('add guard');
    });

    it('accumulates evidence from prior state', () => {
        const ev1: DebugEvidence = { type: 'observation', description: 'ev1', data: 'd1' };
        const ev2: DebugEvidence = { type: 'error-log', description: 'ev2', data: 'd2' };
        const state: DebugState = { ...createInitialState('bug'), evidence: [ev1] };
        const next = advancePhase(state, [ev2]);
        expect(next.evidence).toHaveLength(2);
        expect(next.evidence[0]).toBe(ev1);
        expect(next.evidence[1]).toBe(ev2);
    });

    it('stays on last phase if already at verification', () => {
        const state: DebugState = { ...createInitialState('bug'), phase: 'verification' };
        const next = advancePhase(state);
        expect(next.phase).toBe('verification');
    });
});

describe('formatDebugReport', () => {
    it('includes all sections', () => {
        const state: DebugState = {
            phase: 'verification',
            bugDescription: 'App crashes on startup',
            evidence: [{ type: 'error-log', description: 'null ref', data: 'at line 10' }],
            hypotheses: [{
                id: 1,
                description: 'Missing init',
                likelihood: 'high',
                testPlan: 'Check constructor',
                disproved: false,
            }],
            rootCause: 'Missing initialization',
            fix: 'Call init() before use',
            verified: true,
        };

        const report = formatDebugReport(state);
        expect(report).toContain('App crashes on startup');
        expect(report).toContain('Investigation');
        expect(report).toContain('Evidence');
        expect(report).toContain('Hypothes');
        expect(report).toContain('Verification');
        expect(report).toContain('Missing initialization');
        expect(report).toContain('Call init() before use');
        expect(report).toContain('PASSED');
    });

    it('shows PENDING when not verified', () => {
        const state = createInitialState('unresolved bug');
        const report = formatDebugReport(state);
        expect(report).toContain('PENDING');
    });

    it('notes when no hypotheses formed', () => {
        const state = createInitialState('new bug');
        const report = formatDebugReport(state);
        expect(report).toContain('No hypotheses formed yet');
    });
});
