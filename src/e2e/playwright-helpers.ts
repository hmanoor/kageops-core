/**
 * Playwright E2E Test Helpers for KageOps Electron Application
 *
 * Provides test utilities, types, and helpers for running
 * Playwright-based E2E tests against Electron windows.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ElectronTestContext {
  readonly appPath: string;
  readonly windowTitle: string;
  readonly timeout: number;
  readonly headless: boolean;
  readonly slowMo: number;
}

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly timestamp: string;
  readonly elementCount: number;
  readonly consoleErrors: readonly string[];
}

export interface TestStep {
  readonly name: string;
  readonly action: string;
  readonly selector: string | null;
  readonly expected: string | null;
  readonly timeout: number;
}

export interface StepResult {
  readonly step: TestStep;
  readonly passed: boolean;
  readonly duration: number;
  readonly error: string | null;
  readonly screenshotPath: string | null;
}

export interface FlowResult {
  readonly flowName: string;
  readonly steps: readonly StepResult[];
  readonly passed: boolean;
  readonly duration: number;
  readonly screenshots: readonly string[];
}

export interface WaitCondition {
  readonly type: 'selector' | 'text' | 'url' | 'timeout';
  readonly value: string;
  readonly timeout: number;
}

export interface TestFixture {
  readonly name: string;
  readonly setup: readonly TestStep[];
  readonly teardown: readonly TestStep[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_STEP_TIMEOUT = 5000;

export const STANDARD_SELECTORS: Readonly<Record<string, string>> = {
  'command-center': '#command-center',
  'new-project-btn': '#new-project-btn',
  'agents-tab': '#agents-tab',
  'approval-card': '.approval-card',
  'trace-tree': '#trace-tree',
  'settings-panel': '#settings-panel',
  'chat-input': '.chat-input',
  'overlay-pet': '.overlay-pet',
  'project-name': '#project-name',
  'create-btn': '#create-btn',
  'approve-gate-btn': '#approve-gate-btn',
  'send-btn': '#send-btn',
  'traces-tab': '#traces-tab',
  'settings-btn': '#settings-btn',
  'save-settings-btn': '#save-settings-btn',
};

// ---------------------------------------------------------------------------
// Flow step definitions
// ---------------------------------------------------------------------------

const FLOW_STEPS: Readonly<Record<string, readonly TestStep[]>> = {
  'start-project': [
    { name: 'Navigate to command center', action: 'navigate', selector: '#command-center', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Click new project', action: 'click', selector: '#new-project-btn', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Fill project name', action: 'fill', selector: '#project-name', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Submit form', action: 'click', selector: '#create-btn', expected: 'visible:.project-card', timeout: DEFAULT_STEP_TIMEOUT },
  ],
  'approve-gate': [
    { name: 'Navigate to approvals', action: 'navigate', selector: '.approval-card', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Select pending gate', action: 'click', selector: '.phase-gate-pending', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Click approve', action: 'click', selector: '#approve-gate-btn', expected: 'visible:.phase-gate-approved', timeout: DEFAULT_STEP_TIMEOUT },
  ],
  'view-agents': [
    { name: 'Open command center', action: 'navigate', selector: '#command-center', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Click agents tab', action: 'click', selector: '#agents-tab', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Verify agent list', action: 'assert', selector: '.agent-list', expected: 'visible', timeout: DEFAULT_STEP_TIMEOUT },
  ],
  'check-traces': [
    { name: 'Open traces panel', action: 'click', selector: '#traces-tab', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Select trace', action: 'click', selector: '#trace-tree', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Verify trace tree', action: 'assert', selector: '#trace-tree', expected: 'visible', timeout: DEFAULT_STEP_TIMEOUT },
  ],
  'configure-settings': [
    { name: 'Open settings', action: 'click', selector: '#settings-btn', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Modify value', action: 'fill', selector: '#api-key-input', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Save settings', action: 'click', selector: '#save-settings-btn', expected: null, timeout: DEFAULT_STEP_TIMEOUT },
    { name: 'Verify saved', action: 'assert', selector: '.settings-saved-toast', expected: 'visible', timeout: DEFAULT_STEP_TIMEOUT },
  ],
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const FLOW_FIXTURES: readonly TestFixture[] = [
  {
    name: 'start-project',
    setup: [{ name: 'Ensure command center loaded', action: 'navigate', selector: '#command-center', expected: 'visible', timeout: DEFAULT_STEP_TIMEOUT }],
    teardown: [{ name: 'Delete test project', action: 'click', selector: '#delete-project-btn', expected: null, timeout: DEFAULT_STEP_TIMEOUT }],
  },
  {
    name: 'approve-gate',
    setup: [{ name: 'Create pending gate', action: 'navigate', selector: '.approval-card', expected: 'visible', timeout: DEFAULT_STEP_TIMEOUT }],
    teardown: [{ name: 'Reset gate state', action: 'click', selector: '#reset-gate-btn', expected: null, timeout: DEFAULT_STEP_TIMEOUT }],
  },
  {
    name: 'view-agents',
    setup: [{ name: 'Load command center', action: 'navigate', selector: '#command-center', expected: 'visible', timeout: DEFAULT_STEP_TIMEOUT }],
    teardown: [{ name: 'Close agents tab', action: 'click', selector: '#close-tab-btn', expected: null, timeout: DEFAULT_STEP_TIMEOUT }],
  },
  {
    name: 'check-traces',
    setup: [{ name: 'Ensure traces exist', action: 'navigate', selector: '#traces-tab', expected: 'visible', timeout: DEFAULT_STEP_TIMEOUT }],
    teardown: [{ name: 'Close traces panel', action: 'click', selector: '#close-traces-btn', expected: null, timeout: DEFAULT_STEP_TIMEOUT }],
  },
  {
    name: 'configure-settings',
    setup: [{ name: 'Open settings panel', action: 'click', selector: '#settings-btn', expected: 'visible', timeout: DEFAULT_STEP_TIMEOUT }],
    teardown: [{ name: 'Reset settings', action: 'click', selector: '#reset-settings-btn', expected: null, timeout: DEFAULT_STEP_TIMEOUT }],
  },
];

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function createTestContext(
  overrides?: Partial<ElectronTestContext>,
): ElectronTestContext {
  return {
    appPath: './dist/main/main.js',
    windowTitle: 'KageOps',
    timeout: DEFAULT_TIMEOUT,
    headless: true,
    slowMo: 0,
    ...overrides,
  };
}

export function buildTestSteps(flowName: string): readonly TestStep[] {
  const steps = FLOW_STEPS[flowName];
  if (!steps) {
    return [];
  }
  return steps;
}

export function createWaitCondition(
  type: WaitCondition['type'],
  value: string,
  timeout: number = DEFAULT_STEP_TIMEOUT,
): WaitCondition {
  return { type, value, timeout };
}

export function buildFlowResult(
  flowName: string,
  stepResults: readonly StepResult[],
): FlowResult {
  const passed = stepResults.length > 0 && stepResults.every((r) => r.passed);
  const duration = stepResults.reduce((sum, r) => sum + r.duration, 0);
  const screenshots = stepResults
    .map((r) => r.screenshotPath)
    .filter((p): p is string => p !== null);

  return { flowName, steps: stepResults, passed, duration, screenshots };
}

export function buildStepResult(
  step: TestStep,
  passed: boolean,
  durationMs: number,
  error?: string,
): StepResult {
  return {
    step,
    passed,
    duration: durationMs,
    error: error ?? null,
    screenshotPath: passed ? null : getScreenshotName(step.name, 0),
  };
}

export function getScreenshotName(flowName: string, stepIndex: number): string {
  const slug = flowName.toLowerCase().replace(/\s+/g, '-');
  const padded = String(stepIndex + 1).padStart(2, '0');
  return `${slug}_step-${padded}.png`;
}

export function estimateFlowDuration(steps: readonly TestStep[]): number {
  return steps.reduce((sum, s) => sum + s.timeout, 0);
}

export function filterFlowsByTag(
  flows: readonly { readonly name: string; readonly tags: readonly string[] }[],
  tag: string,
): readonly { readonly name: string; readonly tags: readonly string[] }[] {
  return flows.filter((f) => f.tags.includes(tag));
}

export function formatFlowReport(results: readonly FlowResult[]): string {
  const lines: string[] = [
    '# E2E Flow Report',
    '',
  ];

  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    lines.push(`${icon} **${result.flowName}** — ${result.duration}ms`);
    for (const step of result.steps) {
      const stepIcon = step.passed ? '✅' : '❌';
      lines.push(`  ${stepIcon} ${step.step.name} (${step.duration}ms)`);
    }
    lines.push('');
  }

  const { passed, failed, total } = countFlowsByStatus(results);
  lines.push(`**Total:** ${total} | **Passed:** ${passed} | **Failed:** ${failed}`);

  return lines.join('\n');
}

export function formatStepLog(result: StepResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const selector = result.step.selector ?? '-';
  const error = result.error ? ` | ${result.error}` : '';
  return `[${status}] ${result.step.action} ${selector} (${result.duration}ms)${error}`;
}

export function generatePlaywrightConfig(context: ElectronTestContext): string {
  return [
    'import { defineConfig } from "@playwright/test";',
    '',
    'export default defineConfig({',
    `  timeout: ${context.timeout},`,
    '  use: {',
    `    headless: ${context.headless},`,
    `    launchOptions: { slowMo: ${context.slowMo} },`,
    '  },',
    '  projects: [',
    '    {',
    `      name: "${context.windowTitle}",`,
    '      testDir: "./tests/e2e",',
    '    },',
    '  ],',
    '});',
  ].join('\n');
}

export function countFlowsByStatus(
  results: readonly FlowResult[],
): { readonly passed: number; readonly failed: number; readonly total: number } {
  const passed = results.filter((r) => r.passed).length;
  return { passed, failed: results.length - passed, total: results.length };
}
