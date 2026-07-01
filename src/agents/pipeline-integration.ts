// Pipeline Integration — bridges recipe-engine and adversary-reviewer into the agent execution pipeline

import {
  validateRecipe,
  validateParams,
  BUILT_IN_RECIPES,
} from '../recipes/recipe-engine';
import {
  detectPromptInjection,
  detectHiddenInstructions,
  assessThreatSeverity,
  INJECTION_PATTERNS,
} from '../security/adversary-reviewer';

// ── Types ──────────────────────────────────────────────────────────

export type PipelineStage =
  | 'pre-check'
  | 'recipe-resolve'
  | 'execute'
  | 'post-check'
  | 'review';

export interface PipelineContext {
  readonly taskId: string;
  readonly agentId: string;
  readonly stage: PipelineStage;
  readonly recipeId: string | null;
  readonly securityCleared: boolean;
  readonly startedAt: string;
}

export interface StageResult {
  readonly stage: PipelineStage;
  readonly success: boolean;
  readonly durationMs: number;
  readonly output: string;
  readonly warnings: readonly string[];
}

export interface PipelineResult {
  readonly taskId: string;
  readonly stages: readonly StageResult[];
  readonly overallSuccess: boolean;
  readonly blockedByStage: string | null;
  readonly totalDuration: number;
}

export interface SecurityCheckpoint {
  readonly passed: boolean;
  readonly threatsFound: number;
  readonly highestSeverity: string;
  readonly blockedReason: string | null;
}

export interface RecipeResolution {
  readonly recipeId: string | null;
  readonly resolved: boolean;
  readonly stepsCount: number;
  readonly paramErrors: readonly string[];
}

// ── Constants ──────────────────────────────────────────────────────

export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  'pre-check',
  'recipe-resolve',
  'execute',
  'post-check',
  'review',
] as const;

// ── Functions ──────────────────────────────────────────────────────

export function createPipelineContext(
  taskId: string,
  agentId: string,
  recipeId: string | null,
): PipelineContext {
  return {
    taskId,
    agentId,
    stage: 'pre-check',
    recipeId,
    securityCleared: false,
    startedAt: new Date().toISOString(),
  };
}

export function advanceStage(
  context: PipelineContext,
  nextStage: PipelineStage,
): PipelineContext {
  return { ...context, stage: nextStage };
}

export function isValidTransition(
  from: PipelineStage,
  to: PipelineStage,
): boolean {
  const fromIdx = PIPELINE_STAGE_ORDER.indexOf(from);
  const toIdx = PIPELINE_STAGE_ORDER.indexOf(to);
  return fromIdx >= 0 && toIdx >= 0 && toIdx > fromIdx;
}

export function runSecurityPreCheck(
  content: string,
  agentId: string,
): SecurityCheckpoint {
  const injectionThreats = detectPromptInjection(content, INJECTION_PATTERNS);
  const hiddenThreats = detectHiddenInstructions(content);
  const allThreats = [...injectionThreats, ...hiddenThreats];
  const severity = assessThreatSeverity(allThreats);

  const passed = severity === 'none' || severity === 'low';
  const blockedReason = passed
    ? null
    : `Agent ${agentId} blocked: ${severity} severity threat detected`;

  return {
    passed,
    threatsFound: allThreats.length,
    highestSeverity: severity,
    blockedReason,
  };
}

export function resolveRecipeForTask(
  recipeId: string | null,
  paramValues: Readonly<Record<string, string | number | boolean>>,
): RecipeResolution {
  if (recipeId === null) {
    return { recipeId: null, resolved: false, stepsCount: 0, paramErrors: [] };
  }

  const recipe = BUILT_IN_RECIPES.find((r) => r.id === recipeId);
  if (!recipe) {
    return {
      recipeId,
      resolved: false,
      stepsCount: 0,
      paramErrors: [`Recipe not found: ${recipeId}`],
    };
  }

  const recipeErrors = validateRecipe(recipe);
  if (recipeErrors.length > 0) {
    return {
      recipeId,
      resolved: false,
      stepsCount: recipe.steps.length,
      paramErrors: recipeErrors.map((e) => e.message),
    };
  }

  const paramErrors = validateParams(recipe, paramValues);
  if (paramErrors.length > 0) {
    return {
      recipeId,
      resolved: false,
      stepsCount: recipe.steps.length,
      paramErrors: paramErrors.map((e) => e.message),
    };
  }

  return {
    recipeId,
    resolved: true,
    stepsCount: recipe.steps.length,
    paramErrors: [],
  };
}

export function createStageResult(
  stage: PipelineStage,
  success: boolean,
  durationMs: number,
  output: string,
  warnings: readonly string[] = [],
): StageResult {
  return { stage, success, durationMs, output, warnings };
}

export function buildPipelineResult(
  stages: readonly StageResult[],
): PipelineResult {
  const firstFailed = stages.find((s) => !s.success);
  const taskId = stages.length > 0 ? 'pipeline' : 'empty';
  return {
    taskId,
    stages,
    overallSuccess: firstFailed === undefined,
    blockedByStage: firstFailed?.stage ?? null,
    totalDuration: stages.reduce((sum, s) => sum + s.durationMs, 0),
  };
}

export function getBlockingStage(
  result: PipelineResult,
): StageResult | null {
  return result.stages.find((s) => !s.success) ?? null;
}

export function formatPipelineReport(result: PipelineResult): string {
  const lines: string[] = [
    '# Pipeline Report',
    '',
    `**Task:** ${result.taskId}`,
    `**Overall:** ${result.overallSuccess ? 'SUCCESS' : 'FAILED'}`,
    `**Duration:** ${result.totalDuration}ms`,
    '',
    '## Stages',
    '',
  ];

  for (const s of result.stages) {
    const icon = s.success ? 'PASS' : 'FAIL';
    lines.push(`### [${icon}] ${s.stage} (${s.durationMs}ms)`);
    lines.push('');
    lines.push(s.output);
    if (s.warnings.length > 0) {
      lines.push('');
      lines.push('**Warnings:**');
      for (const w of s.warnings) {
        lines.push(`- ${w}`);
      }
    }
    lines.push('');
  }

  if (result.blockedByStage) {
    lines.push(`**Blocked by:** ${result.blockedByStage}`);
  }

  return lines.join('\n');
}

export function shouldSkipStage(
  stage: PipelineStage,
  context: PipelineContext,
): boolean {
  if (stage === 'recipe-resolve' && context.recipeId === null) {
    return true;
  }
  return false;
}

export function getPipelineMetrics(
  results: readonly PipelineResult[],
): { readonly avgDuration: number; readonly successRate: number; readonly mostBlockedStage: string } {
  if (results.length === 0) {
    return { avgDuration: 0, successRate: 0, mostBlockedStage: 'none' };
  }

  const avgDuration =
    results.reduce((sum, r) => sum + r.totalDuration, 0) / results.length;

  const successCount = results.filter((r) => r.overallSuccess).length;
  const successRate = successCount / results.length;

  const blockCounts = new Map<string, number>();
  for (const r of results) {
    if (r.blockedByStage) {
      blockCounts.set(
        r.blockedByStage,
        (blockCounts.get(r.blockedByStage) ?? 0) + 1,
      );
    }
  }

  let mostBlockedStage = 'none';
  let maxBlocks = 0;
  for (const [stage, count] of blockCounts) {
    if (count > maxBlocks) {
      maxBlocks = count;
      mostBlockedStage = stage;
    }
  }

  return { avgDuration, successRate, mostBlockedStage };
}
