export interface ConversationTurn {
  readonly turnIndex: number;
  readonly role: 'orchestrator' | 'agent' | 'reviewer' | 'user';
  readonly agent: string | null;
  readonly action: string;
  readonly input: string;
  readonly output: string;
  readonly durationMs: number;
  readonly tokenCount: number;
  readonly cost: number;
}

export interface MultiTurnScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly turns: readonly ConversationTurn[];
  readonly expectedOutcomes: readonly string[];
  readonly tags: readonly string[];
}

export interface TurnEvalResult {
  readonly turnIndex: number;
  readonly score: number;
  readonly onTrack: boolean;
  readonly reasoning: string;
}

export interface MultiTurnEvalResult {
  readonly scenarioId: string;
  readonly turnResults: readonly TurnEvalResult[];
  readonly overallScore: number;
  readonly outcomesAchieved: readonly boolean[];
  readonly outcomeRate: number;
  readonly totalTurns: number;
  readonly totalCost: number;
  readonly totalTokens: number;
  readonly totalDuration: number;
  readonly derailmentPoint: number | null;
  readonly summary: string;
}

export function createScenario(
  id: string,
  name: string,
  description: string,
  turns: readonly ConversationTurn[],
  expectedOutcomes: readonly string[],
  tags: readonly string[] = [],
): MultiTurnScenario {
  return { id, name, description, turns, expectedOutcomes, tags };
}

export function createTurn(
  turnIndex: number,
  role: ConversationTurn['role'],
  agent: string | null,
  action: string,
  input: string,
  output: string,
  durationMs: number,
  tokenCount: number,
  cost: number,
): ConversationTurn {
  return { turnIndex, role, agent, action, input, output, durationMs, tokenCount, cost };
}

export function buildMultiTurnJudgePrompt(
  scenario: MultiTurnScenario,
  turnIndex: number,
): string {
  const priorTurns = scenario.turns.slice(0, turnIndex);
  const currentTurn = scenario.turns[turnIndex];

  const priorContext =
    priorTurns.length > 0
      ? priorTurns
          .map(
            (t) =>
              `[Turn ${t.turnIndex}] Role: ${t.role}${t.agent ? ` (${t.agent})` : ''}\nAction: ${t.action}\nInput: ${t.input}\nOutput: ${t.output}`,
          )
          .join('\n\n')
      : '(No prior turns — this is the first turn.)';

  const outcomesText = scenario.expectedOutcomes
    .map((o, i) => `${i + 1}. ${o}`)
    .join('\n');

  return `You are evaluating a single turn in a multi-step orchestration workflow.

## Scenario
**Name:** ${scenario.name}
**Description:** ${scenario.description}

## Expected Outcomes (overall workflow goals)
${outcomesText}

## Prior Turns (context)
${priorContext}

## Current Turn (Turn ${turnIndex})
Role: ${currentTurn.role}${currentTurn.agent ? ` (${currentTurn.agent})` : ''}
Action: ${currentTurn.action}
Input: ${currentTurn.input}
Output: ${currentTurn.output}

## Instructions
Evaluate whether this turn is progressing the workflow toward the expected outcomes. Consider:
- Does the output make sense given the prior turns?
- Does it advance the workflow toward the expected outcomes?
- Are there any errors, contradictions, or signs of derailment?

Score this turn from 1 (very poor) to 10 (excellent).

## Required Output Format
SCORE: <1-10>
ON_TRACK: <yes|no>
REASONING: <one to two sentence explanation>`;
}

export function parseTurnEvalResult(aiOutput: string, turnIndex: number): TurnEvalResult {
  const scoreMatch = aiOutput.match(/SCORE:\s*(\d+(?:\.\d+)?)/i);
  const onTrackMatch = aiOutput.match(/ON_TRACK:\s*(yes|no)/i);
  const reasoningMatch = aiOutput.match(/REASONING:\s*(.+?)(?=\n[A-Z_]+:|$)/is);

  const score = scoreMatch
    ? Math.min(10, Math.max(1, parseFloat(scoreMatch[1])))
    : 5;

  const onTrack = onTrackMatch ? onTrackMatch[1].toLowerCase() !== 'no' : true;

  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';

  return { turnIndex, score, onTrack, reasoning };
}

export function buildOutcomeCheckPrompt(scenario: MultiTurnScenario): string {
  const turnsText = scenario.turns
    .map(
      (t) =>
        `[Turn ${t.turnIndex}] Role: ${t.role}${t.agent ? ` (${t.agent})` : ''}\nAction: ${t.action}\nOutput: ${t.output}`,
    )
    .join('\n\n');

  const outcomesText = scenario.expectedOutcomes
    .map((o, i) => `OUTCOME_${i + 1}: ${o}`)
    .join('\n');

  return `You are evaluating whether a completed multi-step workflow achieved its expected outcomes.

## Scenario
**Name:** ${scenario.name}
**Description:** ${scenario.description}

## Full Conversation
${turnsText}

## Expected Outcomes
${outcomesText}

## Instructions
For each expected outcome, determine whether it was achieved based on the conversation above.

## Required Output Format (one line per outcome)
${scenario.expectedOutcomes.map((_, i) => `OUTCOME_${i + 1}: <achieved|not-achieved>`).join('\n')}`;
}

export function parseOutcomeResults(
  aiOutput: string,
  expectedOutcomes: readonly string[],
): readonly boolean[] {
  return expectedOutcomes.map((_, i) => {
    const pattern = new RegExp(`OUTCOME_${i + 1}:\\s*(achieved|not-achieved)`, 'i');
    const match = aiOutput.match(pattern);
    if (!match) return false;
    return match[1].toLowerCase() === 'achieved';
  });
}

export function findDerailmentPoint(turnResults: readonly TurnEvalResult[]): number | null {
  // Find the first turn index where onTrack is false AND all subsequent turns are also false
  for (let i = 0; i < turnResults.length; i++) {
    if (!turnResults[i].onTrack) {
      const allSubsequentOffTrack = turnResults.slice(i + 1).every((t) => !t.onTrack);
      if (allSubsequentOffTrack) {
        return turnResults[i].turnIndex;
      }
    }
  }
  return null;
}

export function computeMultiTurnResult(
  scenarioId: string,
  turnResults: readonly TurnEvalResult[],
  outcomesAchieved: readonly boolean[],
  scenario: MultiTurnScenario,
): MultiTurnEvalResult {
  const n = turnResults.length;

  // Weight later turns more: weight[i] = (i + 1) / sum(1..n)
  const weightSum = (n * (n + 1)) / 2;
  const overallScore =
    n > 0
      ? turnResults.reduce((sum, t, i) => sum + t.score * ((i + 1) / weightSum), 0)
      : 0;

  const achievedCount = outcomesAchieved.filter(Boolean).length;
  const outcomeRate = outcomesAchieved.length > 0 ? achievedCount / outcomesAchieved.length : 0;

  const totalCost = scenario.turns.reduce((sum, t) => sum + t.cost, 0);
  const totalTokens = scenario.turns.reduce((sum, t) => sum + t.tokenCount, 0);
  const totalDuration = scenario.turns.reduce((sum, t) => sum + t.durationMs, 0);

  const derailmentPoint = findDerailmentPoint(turnResults);

  const roundedScore = Math.round(overallScore * 100) / 100;
  const summary = buildResultSummary(
    roundedScore,
    outcomeRate,
    n,
    derailmentPoint,
    outcomesAchieved,
    scenario.expectedOutcomes,
  );

  return {
    scenarioId,
    turnResults,
    overallScore: roundedScore,
    outcomesAchieved,
    outcomeRate,
    totalTurns: n,
    totalCost,
    totalTokens,
    totalDuration,
    derailmentPoint,
    summary,
  };
}

function buildResultSummary(
  score: number,
  outcomeRate: number,
  totalTurns: number,
  derailmentPoint: number | null,
  outcomesAchieved: readonly boolean[],
  expectedOutcomes: readonly string[],
): string {
  const achievedCount = outcomesAchieved.filter(Boolean).length;
  const parts: string[] = [
    `Overall score: ${score}/10 across ${totalTurns} turns.`,
    `Outcomes achieved: ${achievedCount}/${expectedOutcomes.length} (${(outcomeRate * 100).toFixed(0)}%).`,
  ];
  if (derailmentPoint !== null) {
    parts.push(`Workflow permanently derailed at turn ${derailmentPoint}.`);
  } else {
    parts.push('No permanent derailment detected.');
  }
  return parts.join(' ');
}

export function formatMultiTurnReport(
  result: MultiTurnEvalResult,
  scenario: MultiTurnScenario,
): string {
  const turnRows = result.turnResults
    .map((t) => {
      const turn = scenario.turns[t.turnIndex];
      const trackIcon = t.onTrack ? '✅' : '❌';
      return `| ${t.turnIndex} | ${turn?.role ?? '-'} | ${turn?.agent ?? '-'} | ${t.score}/10 | ${trackIcon} | ${t.reasoning} |`;
    })
    .join('\n');

  const outcomeRows = scenario.expectedOutcomes
    .map((o, i) => {
      const icon = result.outcomesAchieved[i] ? '✅' : '❌';
      return `| ${icon} | ${o} |`;
    })
    .join('\n');

  const derailmentSection =
    result.derailmentPoint !== null
      ? `## ⚠️ Derailment Analysis\n\nWorkflow permanently went off track at **Turn ${result.derailmentPoint}**.\n\nReasoning: ${result.turnResults.find((t) => t.turnIndex === result.derailmentPoint)?.reasoning ?? 'N/A'}`
      : `## Derailment Analysis\n\nNo permanent derailment detected — workflow remained on track throughout.`;

  return `# Multi-Turn Eval Report: ${scenario.name}

**Scenario ID:** ${result.scenarioId}
**Description:** ${scenario.description}

## Summary

${result.summary}

## Turn-by-Turn Scores

| Turn | Role | Agent | Score | On Track | Reasoning |
|------|------|-------|-------|----------|-----------|
${turnRows}

## Outcome Checklist

| Status | Expected Outcome |
|--------|-----------------|
${outcomeRows}

**Outcome Rate:** ${(result.outcomeRate * 100).toFixed(0)}% (${result.outcomesAchieved.filter(Boolean).length}/${scenario.expectedOutcomes.length})

${derailmentSection}

## Cost Summary

| Metric | Value |
|--------|-------|
| Total Turns | ${result.totalTurns} |
| Total Tokens | ${result.totalTokens.toLocaleString()} |
| Total Cost | $${result.totalCost.toFixed(4)} |
| Total Duration | ${result.totalDuration.toLocaleString()}ms |
| Overall Score | ${result.overallScore}/10 |
`;
}

export function compareTurnEfficiency(
  resultA: MultiTurnEvalResult,
  resultB: MultiTurnEvalResult,
): string {
  if (resultA.scenarioId !== resultB.scenarioId) {
    return `Warning: comparing results from different scenarios (${resultA.scenarioId} vs ${resultB.scenarioId}).`;
  }

  const lines: string[] = [`# Efficiency Comparison: ${resultA.scenarioId}`];

  // Turns
  if (resultA.totalTurns < resultB.totalTurns) {
    lines.push(
      `**Turns:** A is more efficient (${resultA.totalTurns} vs ${resultB.totalTurns} turns — ${resultB.totalTurns - resultA.totalTurns} fewer).`,
    );
  } else if (resultB.totalTurns < resultA.totalTurns) {
    lines.push(
      `**Turns:** B is more efficient (${resultB.totalTurns} vs ${resultA.totalTurns} turns — ${resultA.totalTurns - resultB.totalTurns} fewer).`,
    );
  } else {
    lines.push(`**Turns:** Equal (${resultA.totalTurns} turns each).`);
  }

  // Cost
  if (resultA.totalCost < resultB.totalCost) {
    lines.push(
      `**Cost:** A is cheaper ($${resultA.totalCost.toFixed(4)} vs $${resultB.totalCost.toFixed(4)}).`,
    );
  } else if (resultB.totalCost < resultA.totalCost) {
    lines.push(
      `**Cost:** B is cheaper ($${resultB.totalCost.toFixed(4)} vs $${resultA.totalCost.toFixed(4)}).`,
    );
  } else {
    lines.push(`**Cost:** Equal ($${resultA.totalCost.toFixed(4)} each).`);
  }

  // Outcomes
  lines.push(
    `**Outcome Rate:** A=${(resultA.outcomeRate * 100).toFixed(0)}%, B=${(resultB.outcomeRate * 100).toFixed(0)}%.`,
  );

  // Score
  lines.push(
    `**Overall Score:** A=${resultA.overallScore}/10, B=${resultB.overallScore}/10.`,
  );

  // Derailment
  const aDerail =
    resultA.derailmentPoint !== null ? `Turn ${resultA.derailmentPoint}` : 'None';
  const bDerail =
    resultB.derailmentPoint !== null ? `Turn ${resultB.derailmentPoint}` : 'None';
  lines.push(`**Derailment Point:** A=${aDerail}, B=${bDerail}.`);

  return lines.join('\n');
}
