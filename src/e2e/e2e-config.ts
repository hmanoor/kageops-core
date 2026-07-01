/**
 * E2E Test Suite Configuration
 *
 * Defines test structures, critical user flows, and utilities
 * for end-to-end testing of KageOps Electron application.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface E2eTestSuite {
  readonly name: string;
  readonly tests: readonly E2eTestCase[];
  readonly timeout: number;
  readonly retries: number;
}

export interface E2eTestCase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly E2eStep[];
  readonly tags: readonly string[];
  readonly priority: 'critical' | 'high' | 'medium' | 'low';
}

export interface E2eStep {
  readonly action: string;
  readonly selector: string | null;
  readonly value: string | null;
  readonly assertion: string | null;
  readonly timeout: number;
}

export interface E2eResult {
  readonly testId: string;
  readonly passed: boolean;
  readonly duration: number;
  readonly steps: readonly E2eStepResult[];
  readonly screenshots: readonly string[];
  readonly error: string | null;
}

export interface E2eStepResult {
  readonly step: E2eStep;
  readonly passed: boolean;
  readonly duration: number;
  readonly error: string | null;
}

export interface E2eSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly duration: number;
  readonly suites: readonly { readonly name: string; readonly passed: number; readonly failed: number }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRIORITY_ORDER: Readonly<Record<string, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const DEFAULT_STEP_TIMEOUT = 5000;
const DEFAULT_SUITE_TIMEOUT = 60000;
const DEFAULT_RETRIES = 1;

// ---------------------------------------------------------------------------
// Critical User Flows
// ---------------------------------------------------------------------------

export const CRITICAL_USER_FLOWS: readonly E2eTestCase[] = [
  {
    id: 'flow-start-project',
    name: 'Start a new project',
    description: 'User creates a new project via Command Center',
    tags: ['core', 'project'],
    priority: 'critical',
    steps: [
      { action: 'click', selector: '#new-project-btn', value: null, assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'fill', selector: '#project-name', value: 'Test Project', assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'click', selector: '#create-btn', value: null, assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'assert', selector: '.project-card', value: null, assertion: 'visible', timeout: DEFAULT_STEP_TIMEOUT },
    ],
  },
  {
    id: 'flow-approve-gate',
    name: 'Approve a phase gate',
    description: 'User approves a phase gate transition',
    tags: ['core', 'workflow'],
    priority: 'critical',
    steps: [
      { action: 'click', selector: '.phase-gate-pending', value: null, assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'click', selector: '#approve-gate-btn', value: null, assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'assert', selector: '.phase-gate-approved', value: null, assertion: 'visible', timeout: DEFAULT_STEP_TIMEOUT },
    ],
  },
  {
    id: 'flow-view-agents',
    name: 'View agent roster',
    description: 'User views the list of available agents',
    tags: ['core', 'agents'],
    priority: 'high',
    steps: [
      { action: 'click', selector: '#agents-tab', value: null, assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'assert', selector: '.agent-list', value: null, assertion: 'visible', timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'assert', selector: '.agent-card', value: null, assertion: 'count:8', timeout: DEFAULT_STEP_TIMEOUT },
    ],
  },
  {
    id: 'flow-check-traces',
    name: 'Check event traces',
    description: 'User inspects event trace logs in Command Center',
    tags: ['core', 'observability'],
    priority: 'high',
    steps: [
      { action: 'click', selector: '#traces-tab', value: null, assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'assert', selector: '.trace-list', value: null, assertion: 'visible', timeout: DEFAULT_STEP_TIMEOUT },
    ],
  },
  {
    id: 'flow-configure-settings',
    name: 'Configure settings',
    description: 'User changes application settings',
    tags: ['core', 'settings'],
    priority: 'medium',
    steps: [
      { action: 'click', selector: '#settings-btn', value: null, assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'fill', selector: '#api-key-input', value: 'sk-test-key', assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'click', selector: '#save-settings-btn', value: null, assertion: null, timeout: DEFAULT_STEP_TIMEOUT },
      { action: 'assert', selector: '.settings-saved-toast', value: null, assertion: 'visible', timeout: DEFAULT_STEP_TIMEOUT },
    ],
  },
];

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function createTestSuite(
  name: string,
  tests: readonly E2eTestCase[],
  overrides?: Partial<Omit<E2eTestSuite, 'name' | 'tests'>>,
): E2eTestSuite {
  return {
    name,
    tests,
    timeout: DEFAULT_SUITE_TIMEOUT,
    retries: DEFAULT_RETRIES,
    ...overrides,
  };
}

export function filterByTag(
  tests: readonly E2eTestCase[],
  tag: string,
): readonly E2eTestCase[] {
  return tests.filter((t) => t.tags.includes(tag));
}

export function filterByPriority(
  tests: readonly E2eTestCase[],
  minPriority: 'critical' | 'high' | 'medium' | 'low',
): readonly E2eTestCase[] {
  const threshold = PRIORITY_ORDER[minPriority] ?? 3;
  return tests.filter(
    (t) => (PRIORITY_ORDER[t.priority] ?? 3) <= threshold,
  );
}

export function computeSummary(
  results: readonly E2eResult[],
): E2eSummary {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const duration = results.reduce((sum, r) => sum + r.duration, 0);

  return {
    total: results.length,
    passed,
    failed,
    skipped: 0,
    duration,
    suites: [],
  };
}

export function formatE2eReport(summary: E2eSummary): string {
  const lines: string[] = [
    '# E2E Test Report',
    '',
    `- **Total:** ${summary.total}`,
    `- **Passed:** ${summary.passed}`,
    `- **Failed:** ${summary.failed}`,
    `- **Skipped:** ${summary.skipped}`,
    `- **Duration:** ${summary.duration}ms`,
    '',
  ];

  if (summary.suites.length > 0) {
    lines.push('## Suites', '');
    for (const suite of summary.suites) {
      lines.push(`- **${suite.name}**: ${suite.passed} passed, ${suite.failed} failed`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function estimateRunTime(suite: E2eTestSuite): number {
  return suite.tests.reduce(
    (total, test) =>
      total + test.steps.reduce((sum, step) => sum + step.timeout, 0),
    0,
  );
}

export function getFailedTests(
  results: readonly E2eResult[],
): readonly E2eResult[] {
  return results.filter((r) => !r.passed);
}

export function formatStepLog(result: E2eStepResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const action = result.step.action;
  const selector = result.step.selector ?? '-';
  const error = result.error ? ` | ${result.error}` : '';
  return `[${status}] ${action} ${selector} (${result.duration}ms)${error}`;
}
