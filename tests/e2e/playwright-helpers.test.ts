import { describe, it, expect } from 'vitest';
import {
  createTestContext,
  buildTestSteps,
  buildFlowResult,
  buildStepResult,
  getScreenshotName,
  createWaitCondition,
  estimateFlowDuration,
  filterFlowsByTag,
  formatFlowReport,
  formatStepLog,
  generatePlaywrightConfig,
  countFlowsByStatus,
  STANDARD_SELECTORS,
  FLOW_FIXTURES,
  type TestStep,
  type StepResult,
  type FlowResult,
} from '../../src/e2e/playwright-helpers';

// ---------------------------------------------------------------------------
// createTestContext
// ---------------------------------------------------------------------------

describe('createTestContext', () => {
  it('returns correct defaults', () => {
    const ctx = createTestContext();
    expect(ctx.timeout).toBe(30000);
    expect(ctx.headless).toBe(true);
    expect(ctx.slowMo).toBe(0);
    expect(ctx.appPath).toBe('./dist/main/main.js');
    expect(ctx.windowTitle).toBe('KageOps');
  });

  it('applies overrides', () => {
    const ctx = createTestContext({ timeout: 10000, headless: false, slowMo: 50 });
    expect(ctx.timeout).toBe(10000);
    expect(ctx.headless).toBe(false);
    expect(ctx.slowMo).toBe(50);
  });

  it('preserves defaults for non-overridden fields', () => {
    const ctx = createTestContext({ timeout: 5000 });
    expect(ctx.headless).toBe(true);
    expect(ctx.slowMo).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildTestSteps
// ---------------------------------------------------------------------------

const ALL_FLOW_NAMES = [
  'start-project',
  'approve-gate',
  'view-agents',
  'check-traces',
  'configure-settings',
] as const;

describe('buildTestSteps', () => {
  it.each(ALL_FLOW_NAMES)('generates non-empty steps for "%s"', (flowName) => {
    const steps = buildTestSteps(flowName);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.name).toBeTruthy();
      expect(step.action).toBeTruthy();
      expect(step.timeout).toBeGreaterThan(0);
    }
  });

  it('returns empty array for unknown flow', () => {
    expect(buildTestSteps('nonexistent')).toEqual([]);
  });

  it('start-project has 4 steps', () => {
    expect(buildTestSteps('start-project')).toHaveLength(4);
  });

  it('steps are immutable (frozen-like)', () => {
    const steps = buildTestSteps('start-project');
    // readonly — TypeScript prevents mutation at compile time;
    // at runtime we verify the reference is stable
    expect(buildTestSteps('start-project')).toBe(steps);
  });
});

// ---------------------------------------------------------------------------
// buildFlowResult / buildStepResult
// ---------------------------------------------------------------------------

describe('buildFlowResult', () => {
  const passingStep: StepResult = {
    step: { name: 'a', action: 'click', selector: null, expected: null, timeout: 1000 },
    passed: true,
    duration: 100,
    error: null,
    screenshotPath: null,
  };

  const failingStep: StepResult = {
    step: { name: 'b', action: 'assert', selector: '#x', expected: 'visible', timeout: 1000 },
    passed: false,
    duration: 200,
    error: 'not found',
    screenshotPath: 'b_step-01.png',
  };

  it('marks flow as passed when all steps pass', () => {
    const result = buildFlowResult('test', [passingStep, passingStep]);
    expect(result.passed).toBe(true);
    expect(result.duration).toBe(200);
  });

  it('marks flow as failed when any step fails', () => {
    const result = buildFlowResult('test', [passingStep, failingStep]);
    expect(result.passed).toBe(false);
  });

  it('marks flow as failed when no steps provided', () => {
    const result = buildFlowResult('empty', []);
    expect(result.passed).toBe(false);
  });

  it('collects screenshots from failed steps', () => {
    const result = buildFlowResult('test', [passingStep, failingStep]);
    expect(result.screenshots).toEqual(['b_step-01.png']);
  });

  it('sums duration across all steps', () => {
    const result = buildFlowResult('test', [passingStep, failingStep]);
    expect(result.duration).toBe(300);
  });
});

describe('buildStepResult', () => {
  const step: TestStep = { name: 'click btn', action: 'click', selector: '#btn', expected: null, timeout: 5000 };

  it('builds passing result without error', () => {
    const r = buildStepResult(step, true, 50);
    expect(r.passed).toBe(true);
    expect(r.error).toBeNull();
    expect(r.screenshotPath).toBeNull();
  });

  it('builds failing result with error and screenshot', () => {
    const r = buildStepResult(step, false, 100, 'timeout');
    expect(r.passed).toBe(false);
    expect(r.error).toBe('timeout');
    expect(r.screenshotPath).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// getScreenshotName
// ---------------------------------------------------------------------------

describe('getScreenshotName', () => {
  it('formats name with zero-padded index', () => {
    expect(getScreenshotName('start-project', 0)).toBe('start-project_step-01.png');
    expect(getScreenshotName('start-project', 9)).toBe('start-project_step-10.png');
  });

  it('converts spaces to dashes and lowercases', () => {
    expect(getScreenshotName('My Flow Name', 2)).toBe('my-flow-name_step-03.png');
  });
});

// ---------------------------------------------------------------------------
// createWaitCondition
// ---------------------------------------------------------------------------

describe('createWaitCondition', () => {
  it('creates condition with defaults', () => {
    const wc = createWaitCondition('selector', '#el');
    expect(wc.type).toBe('selector');
    expect(wc.value).toBe('#el');
    expect(wc.timeout).toBe(5000);
  });

  it('accepts custom timeout', () => {
    const wc = createWaitCondition('text', 'hello', 10000);
    expect(wc.timeout).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// STANDARD_SELECTORS
// ---------------------------------------------------------------------------

describe('STANDARD_SELECTORS', () => {
  const EXPECTED_KEYS = [
    'command-center',
    'new-project-btn',
    'agents-tab',
    'approval-card',
    'trace-tree',
    'settings-panel',
    'chat-input',
    'overlay-pet',
    'project-name',
    'create-btn',
    'approve-gate-btn',
    'send-btn',
    'traces-tab',
    'settings-btn',
    'save-settings-btn',
  ] as const;

  it('has 15 selectors', () => {
    expect(Object.keys(STANDARD_SELECTORS)).toHaveLength(15);
  });

  it.each(EXPECTED_KEYS)('contains key "%s"', (key) => {
    expect(STANDARD_SELECTORS[key]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// FLOW_FIXTURES
// ---------------------------------------------------------------------------

describe('FLOW_FIXTURES', () => {
  it('has a fixture for each of the 5 flows', () => {
    expect(FLOW_FIXTURES).toHaveLength(5);
  });

  it.each(ALL_FLOW_NAMES)('has fixture for "%s" with setup and teardown', (flowName) => {
    const fixture = FLOW_FIXTURES.find((f) => f.name === flowName);
    expect(fixture).toBeDefined();
    expect(fixture!.setup.length).toBeGreaterThan(0);
    expect(fixture!.teardown.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// estimateFlowDuration
// ---------------------------------------------------------------------------

describe('estimateFlowDuration', () => {
  it('sums step timeouts', () => {
    const steps: readonly TestStep[] = [
      { name: 'a', action: 'click', selector: null, expected: null, timeout: 1000 },
      { name: 'b', action: 'click', selector: null, expected: null, timeout: 2000 },
    ];
    expect(estimateFlowDuration(steps)).toBe(3000);
  });

  it('returns 0 for empty steps', () => {
    expect(estimateFlowDuration([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// filterFlowsByTag
// ---------------------------------------------------------------------------

describe('filterFlowsByTag', () => {
  const flows = [
    { name: 'a', tags: ['core', 'project'] as readonly string[] },
    { name: 'b', tags: ['core', 'chat'] as readonly string[] },
    { name: 'c', tags: ['settings'] as readonly string[] },
  ];

  it('filters by matching tag', () => {
    expect(filterFlowsByTag(flows, 'core')).toHaveLength(2);
  });

  it('returns empty for unmatched tag', () => {
    expect(filterFlowsByTag(flows, 'nonexistent')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatFlowReport
// ---------------------------------------------------------------------------

describe('formatFlowReport', () => {
  const makeResult = (name: string, passed: boolean): FlowResult => ({
    flowName: name,
    steps: [],
    passed,
    duration: 100,
    screenshots: [],
  });

  it('produces markdown with header', () => {
    const report = formatFlowReport([makeResult('test', true)]);
    expect(report).toContain('# E2E Flow Report');
  });

  it('shows pass icon for passing flows', () => {
    const report = formatFlowReport([makeResult('test', true)]);
    expect(report).toContain('✅');
  });

  it('shows fail icon for failing flows', () => {
    const report = formatFlowReport([makeResult('test', false)]);
    expect(report).toContain('❌');
  });

  it('includes totals line', () => {
    const report = formatFlowReport([makeResult('a', true), makeResult('b', false)]);
    expect(report).toContain('**Total:** 2');
    expect(report).toContain('**Passed:** 1');
    expect(report).toContain('**Failed:** 1');
  });
});

// ---------------------------------------------------------------------------
// formatStepLog
// ---------------------------------------------------------------------------

describe('formatStepLog', () => {
  it('formats passing step', () => {
    const r: StepResult = {
      step: { name: 'x', action: 'click', selector: '#btn', expected: null, timeout: 1000 },
      passed: true, duration: 50, error: null, screenshotPath: null,
    };
    expect(formatStepLog(r)).toBe('[PASS] click #btn (50ms)');
  });

  it('formats failing step with error', () => {
    const r: StepResult = {
      step: { name: 'x', action: 'assert', selector: null, expected: 'visible', timeout: 1000 },
      passed: false, duration: 200, error: 'not found', screenshotPath: null,
    };
    expect(formatStepLog(r)).toBe('[FAIL] assert - (200ms) | not found');
  });
});

// ---------------------------------------------------------------------------
// generatePlaywrightConfig
// ---------------------------------------------------------------------------

describe('generatePlaywrightConfig', () => {
  it('produces valid config string', () => {
    const ctx = createTestContext();
    const config = generatePlaywrightConfig(ctx);
    expect(config).toContain('defineConfig');
    expect(config).toContain('timeout: 30000');
    expect(config).toContain('headless: true');
    expect(config).toContain('"KageOps"');
    expect(config).toContain('./tests/e2e');
  });

  it('respects custom context values', () => {
    const ctx = createTestContext({ timeout: 60000, slowMo: 100, windowTitle: 'Test' });
    const config = generatePlaywrightConfig(ctx);
    expect(config).toContain('timeout: 60000');
    expect(config).toContain('slowMo: 100');
    expect(config).toContain('"Test"');
  });
});

// ---------------------------------------------------------------------------
// countFlowsByStatus
// ---------------------------------------------------------------------------

describe('countFlowsByStatus', () => {
  const make = (passed: boolean): FlowResult => ({
    flowName: 'x', steps: [], passed, duration: 0, screenshots: [],
  });

  it('counts correctly', () => {
    const counts = countFlowsByStatus([make(true), make(true), make(false)]);
    expect(counts).toEqual({ passed: 2, failed: 1, total: 3 });
  });

  it('handles empty array', () => {
    expect(countFlowsByStatus([])).toEqual({ passed: 0, failed: 0, total: 0 });
  });
});
