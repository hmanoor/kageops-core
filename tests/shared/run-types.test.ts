import { describe, it, expect } from 'vitest';
import {
  RUN_TYPE_REGISTRY,
  ACTION_PATTERNS,
  ALL_RUN_TYPES,
  classifyAction,
  classifyEventType,
  getRunTypeInfo,
  groupByRunType,
  formatRunTypeSummary,
  type RunType,
  type ClassifiedAction,
} from '../../src/shared/run-types';

describe('RUN_TYPE_REGISTRY', () => {
  it('has all 10 run types', () => {
    const keys = Object.keys(RUN_TYPE_REGISTRY) as RunType[];
    expect(keys).toHaveLength(10);
    const expected: RunType[] = [
      'orchestrate', 'llm', 'tool', 'review', 'deploy',
      'file-io', 'db', 'event', 'security', 'test',
    ];
    for (const rt of expected) {
      expect(keys).toContain(rt);
    }
  });

  it('each registry entry has label, icon, color, and description', () => {
    for (const rt of ALL_RUN_TYPES) {
      const info = RUN_TYPE_REGISTRY[rt];
      expect(info.label).toBeTruthy();
      expect(info.icon).toBeTruthy();
      expect(info.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(info.description).toBeTruthy();
    }
  });
});

describe('classifyAction', () => {
  it('maps event: prefix to event type', () => {
    const result = classifyAction('event:task.completed');
    expect(result.runType).toBe('event');
    expect(result.confidence).toBe(1);
  });

  it('maps askAI to llm', () => {
    expect(classifyAction('askAI').runType).toBe('llm');
  });

  it('maps sendPrompt to llm', () => {
    expect(classifyAction('sendPrompt').runType).toBe('llm');
  });

  it('maps review to review', () => {
    expect(classifyAction('review.quality').runType).toBe('review');
  });

  it('maps quality.gate to review', () => {
    expect(classifyAction('quality.gate.check').runType).toBe('review');
  });

  it('maps deploy to deploy', () => {
    expect(classifyAction('deploy:production').runType).toBe('deploy');
  });

  it('maps workflow trigger to deploy', () => {
    expect(classifyAction('workflow.trigger').runType).toBe('deploy');
  });

  it('maps writeFile to file-io', () => {
    expect(classifyAction('writeFile').runType).toBe('file-io');
  });

  it('maps git to file-io', () => {
    expect(classifyAction('git.commit').runType).toBe('file-io');
  });

  it('maps query to db', () => {
    expect(classifyAction('query.users').runType).toBe('db');
  });

  it('maps database to db', () => {
    expect(classifyAction('database.migration').runType).toBe('db');
  });

  it('maps security to security', () => {
    expect(classifyAction('security.scan').runType).toBe('security');
  });

  it('maps vulnerability to security', () => {
    expect(classifyAction('vulnerability.check').runType).toBe('security');
  });

  it('maps test to test', () => {
    expect(classifyAction('test:unit').runType).toBe('test');
  });

  it('maps vitest to test', () => {
    expect(classifyAction('vitest.run').runType).toBe('test');
  });

  it('maps mcp to tool', () => {
    expect(classifyAction('mcp.call').runType).toBe('tool');
  });

  it('maps bridge to tool', () => {
    expect(classifyAction('code-graph-bridge').runType).toBe('tool');
  });

  it('maps orchestrate to orchestrate', () => {
    expect(classifyAction('orchestrate.task').runType).toBe('orchestrate');
  });

  it('maps sensei to orchestrate', () => {
    expect(classifyAction('sensei.route').runType).toBe('orchestrate');
  });

  it('maps decompose to orchestrate', () => {
    expect(classifyAction('decompose.task').runType).toBe('orchestrate');
  });

  it('falls back to orchestrate for unknown action', () => {
    const result = classifyAction('some-unknown-action-xyz');
    expect(result.runType).toBe('orchestrate');
    expect(result.confidence).toBe(0.1);
    expect(result.action).toBe('some-unknown-action-xyz');
  });
});

describe('classifyEventType', () => {
  it('maps task.* to orchestrate', () => {
    expect(classifyEventType('task.completed')).toBe('orchestrate');
    expect(classifyEventType('task.started')).toBe('orchestrate');
  });

  it('maps review.* to review', () => {
    expect(classifyEventType('review.passed')).toBe('review');
    expect(classifyEventType('review.failed')).toBe('review');
  });

  it('maps build.* to deploy', () => {
    expect(classifyEventType('build.triggered')).toBe('deploy');
  });

  it('maps cost.* to db', () => {
    expect(classifyEventType('cost.tracked')).toBe('db');
  });

  it('maps agent.* to llm', () => {
    expect(classifyEventType('agent.message')).toBe('llm');
  });

  it('defaults unknown prefix to event', () => {
    expect(classifyEventType('some.random.event')).toBe('event');
    expect(classifyEventType('ping.pong')).toBe('event');
  });
});

describe('getRunTypeInfo', () => {
  it('returns correct info for orchestrate', () => {
    const info = getRunTypeInfo('orchestrate');
    expect(info.type).toBe('orchestrate');
    expect(info.icon).toBe('🎯');
    expect(info.color).toBe('#6366F1');
  });

  it('returns correct info for llm', () => {
    const info = getRunTypeInfo('llm');
    expect(info.icon).toBe('🤖');
    expect(info.color).toBe('#F59E0B');
  });

  it('returns correct info for test', () => {
    const info = getRunTypeInfo('test');
    expect(info.icon).toBe('✅');
    expect(info.color).toBe('#22C55E');
  });
});

describe('ALL_RUN_TYPES', () => {
  it('has 10 entries', () => {
    expect(ALL_RUN_TYPES).toHaveLength(10);
  });

  it('contains all expected run types', () => {
    const expected: RunType[] = [
      'orchestrate', 'llm', 'tool', 'review', 'deploy',
      'file-io', 'db', 'event', 'security', 'test',
    ];
    for (const rt of expected) {
      expect(ALL_RUN_TYPES).toContain(rt);
    }
  });
});

describe('groupByRunType', () => {
  it('groups correctly by run type', () => {
    const actions: ClassifiedAction[] = [
      { action: 'askAI', runType: 'llm', confidence: 1 },
      { action: 'askAI2', runType: 'llm', confidence: 1 },
      { action: 'writeFile', runType: 'file-io', confidence: 1 },
    ];
    const grouped = groupByRunType(actions);
    expect(grouped['llm']).toHaveLength(2);
    expect(grouped['file-io']).toHaveLength(1);
    expect(grouped['test']).toHaveLength(0);
  });

  it('includes all run types even when empty', () => {
    const grouped = groupByRunType([]);
    for (const rt of ALL_RUN_TYPES) {
      expect(grouped[rt]).toBeDefined();
      expect(grouped[rt]).toHaveLength(0);
    }
  });
});

describe('formatRunTypeSummary', () => {
  it('includes all types with counts', () => {
    const actions: ClassifiedAction[] = [
      { action: 'askAI', runType: 'llm', confidence: 1 },
      { action: 'test.run', runType: 'test', confidence: 1 },
      { action: 'test.run2', runType: 'test', confidence: 1 },
    ];
    const grouped = groupByRunType(actions);
    const summary = formatRunTypeSummary(grouped);

    // Should have a header row
    expect(summary).toContain('| Icon | Type | Count |');

    // Should contain each run type label
    for (const rt of ALL_RUN_TYPES) {
      const info = RUN_TYPE_REGISTRY[rt];
      expect(summary).toContain(info.label);
    }

    // Counts should be reflected
    expect(summary).toContain('LLM');
    expect(summary).toContain('Test');
  });

  it('shows 0 counts for types with no actions', () => {
    const grouped = groupByRunType([]);
    const summary = formatRunTypeSummary(grouped);
    // All counts should be 0
    const countMatches = summary.match(/\|\s*\d+\s*\|/g) ?? [];
    for (const match of countMatches) {
      expect(match).toContain('0');
    }
  });
});
