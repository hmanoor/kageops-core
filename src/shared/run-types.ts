/**
 * B-102: Run type taxonomy for KageOps
 * Classifies agent actions for filtering, grouping, and visualizing traces.
 */

export type RunType =
  | 'orchestrate' // Sensei task decomposition, routing, phase gates
  | 'llm'         // AI model call (askAI, sendPrompt)
  | 'tool'        // External tool call (MCP, code-graph-bridge)
  | 'review'      // Code review, quality gate, security review
  | 'deploy'      // CI/CD, deployment, workflow triggers
  | 'file-io'     // Read/write files, git operations
  | 'db'          // Database queries
  | 'event'       // Event bus publish/subscribe
  | 'security'    // Security scanning, vulnerability checks
  | 'test';       // Test execution, coverage checks

export interface RunTypeInfo {
  readonly type: RunType;
  readonly label: string;
  readonly icon: string;
  readonly color: string;
  readonly description: string;
}

export interface ClassifiedAction {
  readonly action: string;
  readonly runType: RunType;
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const RUN_TYPE_REGISTRY: Readonly<Record<RunType, RunTypeInfo>> = {
  orchestrate: {
    type: 'orchestrate',
    label: 'Orchestrate',
    icon: '🎯',
    color: '#6366F1',
    description: 'Sensei task decomposition, routing, and phase gate management',
  },
  llm: {
    type: 'llm',
    label: 'LLM',
    icon: '🤖',
    color: '#F59E0B',
    description: 'AI model call via askAI, sendPrompt, or any model invocation',
  },
  tool: {
    type: 'tool',
    label: 'Tool',
    icon: '🔧',
    color: '#10B981',
    description: 'External tool call including MCP tools and code-graph-bridge',
  },
  review: {
    type: 'review',
    label: 'Review',
    icon: '🔍',
    color: '#8B5CF6',
    description: 'Code review, quality gate checks, and security review actions',
  },
  deploy: {
    type: 'deploy',
    label: 'Deploy',
    icon: '🚀',
    color: '#EF4444',
    description: 'CI/CD pipelines, deployment steps, and workflow triggers',
  },
  'file-io': {
    type: 'file-io',
    label: 'File I/O',
    icon: '📁',
    color: '#3B82F6',
    description: 'Reading and writing files, git operations and commits',
  },
  db: {
    type: 'db',
    label: 'Database',
    icon: '🗄️',
    color: '#14B8A6',
    description: 'Database queries, migrations, and SQL operations',
  },
  event: {
    type: 'event',
    label: 'Event',
    icon: '⚡',
    color: '#F97316',
    description: 'Event bus publish and subscribe operations',
  },
  security: {
    type: 'security',
    label: 'Security',
    icon: '🛡️',
    color: '#EC4899',
    description: 'Security scanning, vulnerability checks, and injection prevention',
  },
  test: {
    type: 'test',
    label: 'Test',
    icon: '✅',
    color: '#22C55E',
    description: 'Test execution, vitest/jest runs, and coverage checks',
  },
} as const;

// ---------------------------------------------------------------------------
// Action patterns
// ---------------------------------------------------------------------------

export const ACTION_PATTERNS: readonly { readonly pattern: RegExp; readonly runType: RunType }[] = [
  { pattern: /^event:/, runType: 'event' },
  { pattern: /askAI|sendPrompt|llm|model/i, runType: 'llm' },
  { pattern: /review|quality.gate|vigil/i, runType: 'review' },
  { pattern: /deploy|ci|cd|workflow|trigger/i, runType: 'deploy' },
  { pattern: /read|write|file|git|branch|commit/i, runType: 'file-io' },
  { pattern: /query|database|migration|sql/i, runType: 'db' },
  { pattern: /security|scan|vulnerability|injection/i, runType: 'security' },
  { pattern: /test|vitest|jest|coverage/i, runType: 'test' },
  { pattern: /mcp|tool|bridge|graph/i, runType: 'tool' },
  { pattern: /orchestrat|decompos|route|phase|sensei/i, runType: 'orchestrate' },
] as const;

// ---------------------------------------------------------------------------
// All run types
// ---------------------------------------------------------------------------

export const ALL_RUN_TYPES: readonly RunType[] = [
  'orchestrate',
  'llm',
  'tool',
  'review',
  'deploy',
  'file-io',
  'db',
  'event',
  'security',
  'test',
] as const;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Classify an action string against ACTION_PATTERNS.
 * Returns the first matching run type with full confidence, or falls back to
 * 'orchestrate' with confidence 0.1 if no pattern matches.
 */
export function classifyAction(action: string): ClassifiedAction {
  for (const { pattern, runType } of ACTION_PATTERNS) {
    if (pattern.test(action)) {
      return { action, runType, confidence: 1 };
    }
  }
  return { action, runType: 'orchestrate', confidence: 0.1 };
}

/**
 * Map an event channel name to the most appropriate RunType.
 * Uses the channel prefix (the part before the first dot).
 */
export function classifyEventType(eventType: string): RunType {
  const prefix = eventType.split('.')[0];
  switch (prefix) {
    case 'task':
      return 'orchestrate';
    case 'review':
      return 'review';
    case 'build':
      return 'deploy';
    case 'cost':
      return 'db';
    case 'agent':
      return 'llm';
    default:
      return 'event';
  }
}

/**
 * Look up metadata for a run type from the registry.
 */
export function getRunTypeInfo(runType: RunType): RunTypeInfo {
  return RUN_TYPE_REGISTRY[runType];
}

/**
 * Group an array of classified actions by their run type.
 * Every RunType key is present in the result (empty arrays for unrepresented types).
 */
export function groupByRunType(
  actions: readonly ClassifiedAction[],
): Readonly<Record<RunType, readonly ClassifiedAction[]>> {
  const mutable = {} as Record<RunType, ClassifiedAction[]>;
  for (const rt of ALL_RUN_TYPES) {
    mutable[rt] = [];
  }
  for (const ca of actions) {
    mutable[ca.runType].push(ca);
  }
  return mutable as Readonly<Record<RunType, readonly ClassifiedAction[]>>;
}

/**
 * Produce a markdown summary table showing icon, type, and count for each
 * run type that has at least one action.
 */
export function formatRunTypeSummary(
  grouped: Readonly<Record<RunType, readonly ClassifiedAction[]>>,
): string {
  const header = '| Icon | Type | Count |\n|------|------|-------|\n';
  const rows = ALL_RUN_TYPES.map((rt) => {
    const info = RUN_TYPE_REGISTRY[rt];
    const count = grouped[rt].length;
    return `| ${info.icon} | ${info.label} | ${count} |`;
  }).join('\n');
  return header + rows;
}
