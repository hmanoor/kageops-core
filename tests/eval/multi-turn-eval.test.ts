import { describe, it, expect } from 'vitest';
import {
  createScenario,
  createTurn,
  buildMultiTurnJudgePrompt,
  parseTurnEvalResult,
  buildOutcomeCheckPrompt,
  parseOutcomeResults,
  computeMultiTurnResult,
  findDerailmentPoint,
  formatMultiTurnReport,
  compareTurnEfficiency,
  type ConversationTurn,
  type TurnEvalResult,
} from '../../src/eval/multi-turn-eval';

// Helpers
function makeTurn(index: number, role: ConversationTurn['role'] = 'agent'): ConversationTurn {
  return createTurn(index, role, `agent-${index}`, `action-${index}`, `input-${index}`, `output-${index}`, 100, 50, 0.01);
}

function makeTurnResult(index: number, score: number, onTrack: boolean): TurnEvalResult {
  return { turnIndex: index, score, onTrack, reasoning: `reason-${index}` };
}

const SAMPLE_TURNS: readonly ConversationTurn[] = [
  makeTurn(0, 'orchestrator'),
  makeTurn(1, 'agent'),
  makeTurn(2, 'reviewer'),
];

const SAMPLE_OUTCOMES = ['Decompose task into subtasks', 'Execute with correct agent', 'Pass review'];

const SAMPLE_SCENARIO = createScenario(
  'sc-001',
  'Full Workflow',
  'Tests the end-to-end orchestration pipeline',
  SAMPLE_TURNS,
  SAMPLE_OUTCOMES,
  ['integration'],
);

// 1. createScenario creates with all fields
describe('createScenario', () => {
  it('creates scenario with all fields', () => {
    const s = createScenario('id1', 'My Scenario', 'desc', SAMPLE_TURNS, SAMPLE_OUTCOMES, ['tag1']);
    expect(s.id).toBe('id1');
    expect(s.name).toBe('My Scenario');
    expect(s.description).toBe('desc');
    expect(s.turns).toBe(SAMPLE_TURNS);
    expect(s.expectedOutcomes).toBe(SAMPLE_OUTCOMES);
    expect(s.tags).toEqual(['tag1']);
  });
});

// 2. createTurn creates with correct turnIndex
describe('createTurn', () => {
  it('creates turn with correct turnIndex', () => {
    const t = createTurn(3, 'agent', 'forge', 'build', 'task input', 'task output', 200, 100, 0.02);
    expect(t.turnIndex).toBe(3);
    expect(t.role).toBe('agent');
    expect(t.agent).toBe('forge');
    expect(t.action).toBe('build');
    expect(t.input).toBe('task input');
    expect(t.output).toBe('task output');
    expect(t.durationMs).toBe(200);
    expect(t.tokenCount).toBe(100);
    expect(t.cost).toBe(0.02);
  });
});

// 3. buildMultiTurnJudgePrompt includes prior turns as context
describe('buildMultiTurnJudgePrompt', () => {
  it('includes prior turns as context', () => {
    const prompt = buildMultiTurnJudgePrompt(SAMPLE_SCENARIO, 2);
    expect(prompt).toContain('[Turn 0]');
    expect(prompt).toContain('[Turn 1]');
    expect(prompt).toContain('output-0');
    expect(prompt).toContain('output-1');
  });

  // 4. buildMultiTurnJudgePrompt includes current turn
  it('includes current turn', () => {
    const prompt = buildMultiTurnJudgePrompt(SAMPLE_SCENARIO, 1);
    expect(prompt).toContain('Current Turn (Turn 1)');
    expect(prompt).toContain('output-1');
  });

  it('handles first turn with no prior context', () => {
    const prompt = buildMultiTurnJudgePrompt(SAMPLE_SCENARIO, 0);
    expect(prompt).toContain('No prior turns');
    expect(prompt).toContain('Current Turn (Turn 0)');
  });

  it('includes expected outcomes', () => {
    const prompt = buildMultiTurnJudgePrompt(SAMPLE_SCENARIO, 0);
    expect(prompt).toContain('Decompose task into subtasks');
  });
});

// 5. parseTurnEvalResult parses score and on-track
describe('parseTurnEvalResult', () => {
  it('parses score and on-track yes', () => {
    const output = 'SCORE: 8\nON_TRACK: yes\nREASONING: Good progress.';
    const result = parseTurnEvalResult(output, 2);
    expect(result.turnIndex).toBe(2);
    expect(result.score).toBe(8);
    expect(result.onTrack).toBe(true);
    expect(result.reasoning).toBe('Good progress.');
  });

  it('parses on-track no', () => {
    const output = 'SCORE: 3\nON_TRACK: no\nREASONING: Went off course.';
    const result = parseTurnEvalResult(output, 1);
    expect(result.onTrack).toBe(false);
    expect(result.score).toBe(3);
  });

  // 6. parseTurnEvalResult defaults on-track to true if missing
  it('defaults on-track to true if missing', () => {
    const output = 'SCORE: 7\nREASONING: Decent turn.';
    const result = parseTurnEvalResult(output, 0);
    expect(result.onTrack).toBe(true);
    expect(result.score).toBe(7);
  });

  it('clamps score to 1-10 range', () => {
    const output = 'SCORE: 15\nON_TRACK: yes\nREASONING: test.';
    const result = parseTurnEvalResult(output, 0);
    expect(result.score).toBe(10);
  });
});

// 7. buildOutcomeCheckPrompt includes all expected outcomes
describe('buildOutcomeCheckPrompt', () => {
  it('includes all expected outcomes', () => {
    const prompt = buildOutcomeCheckPrompt(SAMPLE_SCENARIO);
    for (const outcome of SAMPLE_OUTCOMES) {
      expect(prompt).toContain(outcome);
    }
    expect(prompt).toContain('OUTCOME_1:');
    expect(prompt).toContain('OUTCOME_2:');
    expect(prompt).toContain('OUTCOME_3:');
  });

  it('includes all turns in the full conversation', () => {
    const prompt = buildOutcomeCheckPrompt(SAMPLE_SCENARIO);
    expect(prompt).toContain('[Turn 0]');
    expect(prompt).toContain('[Turn 1]');
    expect(prompt).toContain('[Turn 2]');
  });
});

// 8. parseOutcomeResults parses achieved/not-achieved
describe('parseOutcomeResults', () => {
  it('parses achieved and not-achieved', () => {
    const output = 'OUTCOME_1: achieved\nOUTCOME_2: not-achieved\nOUTCOME_3: achieved';
    const results = parseOutcomeResults(output, SAMPLE_OUTCOMES);
    expect(results).toEqual([true, false, true]);
  });

  // 9. parseOutcomeResults handles missing outcomes
  it('returns false for missing outcomes', () => {
    const output = 'OUTCOME_1: achieved';
    const results = parseOutcomeResults(output, SAMPLE_OUTCOMES);
    expect(results[0]).toBe(true);
    expect(results[1]).toBe(false);
    expect(results[2]).toBe(false);
  });

  it('is case-insensitive', () => {
    const output = 'OUTCOME_1: ACHIEVED\nOUTCOME_2: NOT-ACHIEVED';
    const results = parseOutcomeResults(output, ['a', 'b']);
    expect(results[0]).toBe(true);
    expect(results[1]).toBe(false);
  });
});

// 10. computeMultiTurnResult calculates overall score
describe('computeMultiTurnResult', () => {
  const turnResults: readonly TurnEvalResult[] = [
    makeTurnResult(0, 10, true),
    makeTurnResult(1, 10, true),
    makeTurnResult(2, 10, true),
  ];

  it('calculates overall score (weighted toward later turns)', () => {
    const r = computeMultiTurnResult('sc-001', turnResults, [true, true, true], SAMPLE_SCENARIO);
    expect(r.overallScore).toBeCloseTo(10, 1);
  });

  it('weights later turns more heavily', () => {
    const mixed: readonly TurnEvalResult[] = [
      makeTurnResult(0, 1, true),   // early, low score
      makeTurnResult(1, 10, true),  // later, high score
    ];
    const r = computeMultiTurnResult('sc-001', mixed, [true, true, true], SAMPLE_SCENARIO);
    // weight 1=1/3, weight 2=2/3 => (1*1/3 + 10*2/3) = 7
    expect(r.overallScore).toBeCloseTo(7, 1);
  });

  // 11. computeMultiTurnResult calculates outcome rate
  it('calculates outcome rate', () => {
    const r = computeMultiTurnResult('sc-001', turnResults, [true, false, true], SAMPLE_SCENARIO);
    expect(r.outcomeRate).toBeCloseTo(2 / 3, 5);
  });

  // 12. computeMultiTurnResult calculates totals
  it('calculates totals from scenario turns', () => {
    const r = computeMultiTurnResult('sc-001', turnResults, [true, true, true], SAMPLE_SCENARIO);
    // 3 turns x cost=0.01, tokens=50, duration=100
    expect(r.totalCost).toBeCloseTo(0.03, 5);
    expect(r.totalTokens).toBe(150);
    expect(r.totalDuration).toBe(300);
    expect(r.totalTurns).toBe(3);
  });

  it('sets scenarioId', () => {
    const r = computeMultiTurnResult('sc-abc', turnResults, [true], SAMPLE_SCENARIO);
    expect(r.scenarioId).toBe('sc-abc');
  });
});

// 13. findDerailmentPoint finds first permanent off-track
describe('findDerailmentPoint', () => {
  it('finds first permanent off-track turn', () => {
    const results: readonly TurnEvalResult[] = [
      makeTurnResult(0, 8, true),
      makeTurnResult(1, 4, false),
      makeTurnResult(2, 3, false),
    ];
    expect(findDerailmentPoint(results)).toBe(1);
  });

  // 14. findDerailmentPoint returns null when all on track
  it('returns null when all on track', () => {
    const results: readonly TurnEvalResult[] = [
      makeTurnResult(0, 9, true),
      makeTurnResult(1, 8, true),
      makeTurnResult(2, 7, true),
    ];
    expect(findDerailmentPoint(results)).toBeNull();
  });

  // 15. findDerailmentPoint handles temporary off-track (recovers)
  it('returns null if flow recovers after temporary off-track', () => {
    const results: readonly TurnEvalResult[] = [
      makeTurnResult(0, 9, true),
      makeTurnResult(1, 3, false),  // temporary dip
      makeTurnResult(2, 8, true),   // recovered
    ];
    expect(findDerailmentPoint(results)).toBeNull();
  });

  it('returns null for empty results', () => {
    expect(findDerailmentPoint([])).toBeNull();
  });
});

// 16. formatMultiTurnReport includes all sections
describe('formatMultiTurnReport', () => {
  it('includes all sections', () => {
    const turnResults: readonly TurnEvalResult[] = [
      makeTurnResult(0, 8, true),
      makeTurnResult(1, 7, true),
      makeTurnResult(2, 9, true),
    ];
    const evalResult = computeMultiTurnResult('sc-001', turnResults, [true, false, true], SAMPLE_SCENARIO);
    const report = formatMultiTurnReport(evalResult, SAMPLE_SCENARIO);

    expect(report).toContain('Multi-Turn Eval Report');
    expect(report).toContain('sc-001');
    expect(report).toContain('Turn-by-Turn Scores');
    expect(report).toContain('Outcome Checklist');
    expect(report).toContain('Derailment Analysis');
    expect(report).toContain('Cost Summary');
    expect(report).toContain('Decompose task into subtasks');
    expect(report).toContain('Outcome Rate');
  });

  it('shows derailment point when present', () => {
    const turnResults: readonly TurnEvalResult[] = [
      makeTurnResult(0, 8, true),
      makeTurnResult(1, 2, false),
      makeTurnResult(2, 2, false),
    ];
    const evalResult = computeMultiTurnResult('sc-001', turnResults, [false, false, false], SAMPLE_SCENARIO);
    const report = formatMultiTurnReport(evalResult, SAMPLE_SCENARIO);
    expect(report).toContain('Turn 1');
  });
});

// 17. compareTurnEfficiency reports fewer turns
describe('compareTurnEfficiency', () => {
  it('reports when A has fewer turns', () => {
    const turnsA = [makeTurn(0), makeTurn(1)];
    const turnsB = [makeTurn(0), makeTurn(1), makeTurn(2), makeTurn(3)];

    const scenarioA = createScenario('sc-x', 'X', 'desc', turnsA, ['goal']);
    const scenarioB = createScenario('sc-x', 'X', 'desc', turnsB, ['goal']);

    const resultA = computeMultiTurnResult('sc-x', [makeTurnResult(0, 9, true), makeTurnResult(1, 8, true)], [true], scenarioA);
    const resultB = computeMultiTurnResult('sc-x', [makeTurnResult(0, 7, true), makeTurnResult(1, 6, true), makeTurnResult(2, 5, true), makeTurnResult(3, 4, true)], [true], scenarioB);

    const comparison = compareTurnEfficiency(resultA, resultB);
    expect(comparison).toContain('A is more efficient');
    expect(comparison).toContain('fewer');
  });

  it('warns when comparing different scenarios', () => {
    const s1 = createScenario('sc-1', 'A', '', SAMPLE_TURNS, []);
    const s2 = createScenario('sc-2', 'B', '', SAMPLE_TURNS, []);
    const r1 = computeMultiTurnResult('sc-1', [], [], s1);
    const r2 = computeMultiTurnResult('sc-2', [], [], s2);
    const comparison = compareTurnEfficiency(r1, r2);
    expect(comparison).toContain('Warning');
  });

  it('reports equal turns when same count', () => {
    const r1 = computeMultiTurnResult('sc-001', [makeTurnResult(0, 8, true)], [true], createScenario('sc-001', 'X', '', [makeTurn(0)], ['g']));
    const r2 = computeMultiTurnResult('sc-001', [makeTurnResult(0, 7, true)], [true], createScenario('sc-001', 'X', '', [makeTurn(0)], ['g']));
    const comparison = compareTurnEfficiency(r1, r2);
    expect(comparison).toContain('Equal');
  });
});
