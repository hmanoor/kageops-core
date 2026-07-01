/**
 * E2E Config tests
 */

import { describe, it, expect } from 'vitest';
import {
  CRITICAL_USER_FLOWS,
  PRIORITY_ORDER,
  createTestSuite,
  filterByTag,
  filterByPriority,
  computeSummary,
  formatE2eReport,
  estimateRunTime,
  getFailedTests,
  formatStepLog,
  type E2eResult,
  type E2eStepResult,
  type E2eStep,
} from '../../src/e2e/e2e-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides?: Partial<E2eStep>): E2eStep {
  return {
    action: 'click',
    selector: '#btn',
    value: null,
    assertion: null,
    timeout: 5000,
    ...overrides,
  };
}

function makeResult(overrides?: Partial<E2eResult>): E2eResult {
  return {
    testId: 'test-1',
    passed: true,
    duration: 1000,
    steps: [],
    screenshots: [],
    error: null,
    ...overrides,
  };
}

function makeStepResult(overrides?: Partial<E2eStepResult>): E2eStepResult {
  return {
    step: makeStep(),
    passed: true,
    duration: 200,
    error: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CRITICAL_USER_FLOWS
// ---------------------------------------------------------------------------

describe('CRITICAL_USER_FLOWS', () => {
  it('contains 5 flows', () => {
    expect(CRITICAL_USER_FLOWS).toHaveLength(5);
  });

  it.each([
    'flow-start-project',
    'flow-approve-gate',
    'flow-view-agents',
    'flow-check-traces',
    'flow-configure-settings',
  ])('includes flow %s', (id) => {
    expect(CRITICAL_USER_FLOWS.some((f) => f.id === id)).toBe(true);
  });

  it('all flows have at least one step', () => {
    for (const flow of CRITICAL_USER_FLOWS) {
      expect(flow.steps.length).toBeGreaterThan(0);
    }
  });

  it('all flows have tags', () => {
    for (const flow of CRITICAL_USER_FLOWS) {
      expect(flow.tags.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// PRIORITY_ORDER
// ---------------------------------------------------------------------------

describe('PRIORITY_ORDER', () => {
  it('has correct ordering', () => {
    expect(PRIORITY_ORDER['critical']).toBe(0);
    expect(PRIORITY_ORDER['high']).toBe(1);
    expect(PRIORITY_ORDER['medium']).toBe(2);
    expect(PRIORITY_ORDER['low']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createTestSuite
// ---------------------------------------------------------------------------

describe('createTestSuite', () => {
  it('creates suite with defaults', () => {
    const suite = createTestSuite('smoke', CRITICAL_USER_FLOWS);
    expect(suite.name).toBe('smoke');
    expect(suite.tests).toBe(CRITICAL_USER_FLOWS);
    expect(suite.timeout).toBe(60000);
    expect(suite.retries).toBe(1);
  });

  it('applies overrides', () => {
    const suite = createTestSuite('custom', [], { timeout: 120000, retries: 3 });
    expect(suite.timeout).toBe(120000);
    expect(suite.retries).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// filterByTag / filterByPriority
// ---------------------------------------------------------------------------

describe('filterByTag', () => {
  it('filters flows by tag', () => {
    const agents = filterByTag(CRITICAL_USER_FLOWS, 'agents');
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.every((t) => t.tags.includes('agents'))).toBe(true);
  });

  it('returns empty for unknown tag', () => {
    expect(filterByTag(CRITICAL_USER_FLOWS, 'nonexistent')).toHaveLength(0);
  });
});

describe('filterByPriority', () => {
  it('critical only returns critical tests', () => {
    const critical = filterByPriority(CRITICAL_USER_FLOWS, 'critical');
    expect(critical.every((t) => t.priority === 'critical')).toBe(true);
  });

  it('high includes critical and high', () => {
    const highAndUp = filterByPriority(CRITICAL_USER_FLOWS, 'high');
    expect(highAndUp.every((t) => t.priority === 'critical' || t.priority === 'high')).toBe(true);
    expect(highAndUp.length).toBeGreaterThan(filterByPriority(CRITICAL_USER_FLOWS, 'critical').length);
  });
});

// ---------------------------------------------------------------------------
// computeSummary
// ---------------------------------------------------------------------------

describe('computeSummary', () => {
  it('computes correct totals', () => {
    const results: readonly E2eResult[] = [
      makeResult({ passed: true, duration: 500 }),
      makeResult({ testId: 'test-2', passed: false, duration: 300, error: 'boom' }),
      makeResult({ testId: 'test-3', passed: true, duration: 200 }),
    ];
    const summary = computeSummary(results);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.duration).toBe(1000);
  });

  it('handles empty results', () => {
    const summary = computeSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.duration).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatE2eReport
// ---------------------------------------------------------------------------

describe('formatE2eReport', () => {
  it('contains header and stats', () => {
    const report = formatE2eReport({ total: 5, passed: 4, failed: 1, skipped: 0, duration: 3000, suites: [] });
    expect(report).toContain('# E2E Test Report');
    expect(report).toContain('Passed:** 4');
    expect(report).toContain('Failed:** 1');
  });
});

// ---------------------------------------------------------------------------
// estimateRunTime
// ---------------------------------------------------------------------------

describe('estimateRunTime', () => {
  it('sums step timeouts', () => {
    const suite = createTestSuite('test', CRITICAL_USER_FLOWS);
    const estimate = estimateRunTime(suite);
    const expectedSteps = CRITICAL_USER_FLOWS.reduce(
      (sum, t) => sum + t.steps.reduce((s, step) => s + step.timeout, 0),
      0,
    );
    expect(estimate).toBe(expectedSteps);
  });
});

// ---------------------------------------------------------------------------
// getFailedTests / formatStepLog
// ---------------------------------------------------------------------------

describe('getFailedTests', () => {
  it('returns only failed results', () => {
    const results = [makeResult({ passed: true }), makeResult({ testId: 'f1', passed: false })];
    expect(getFailedTests(results)).toHaveLength(1);
    expect(getFailedTests(results)[0].testId).toBe('f1');
  });
});

describe('formatStepLog', () => {
  it('formats passing step', () => {
    const log = formatStepLog(makeStepResult());
    expect(log).toContain('[PASS]');
    expect(log).toContain('click');
  });

  it('formats failing step with error', () => {
    const log = formatStepLog(makeStepResult({ passed: false, error: 'element not found' }));
    expect(log).toContain('[FAIL]');
    expect(log).toContain('element not found');
  });
});
