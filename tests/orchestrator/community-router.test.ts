import { describe, it, expect } from 'vitest';
import {
  classifyCommunity,
  buildCommunityOwnershipMap,
  routeByFiles,
  routeByDescription,
  mergeRouteSignals,
  COMMUNITY_AGENT_MAP,
} from '../../src/orchestrator/community-router';

describe('classifyCommunity', () => {
  it('routes test-related communities to vigil', () => {
    expect(classifyCommunity('test-suite', [])).toBe('vigil');
    expect(classifyCommunity('vitest-helpers', [])).toBe('vigil');
    expect(classifyCommunity('spec-utils', [])).toBe('vigil');
    expect(classifyCommunity('coverage-reporter', [])).toBe('vigil');
  });

  it('routes infrastructure communities to aegis', () => {
    expect(classifyCommunity('ci-pipeline', [])).toBe('aegis');
    expect(classifyCommunity('docker-compose', [])).toBe('aegis');
    expect(classifyCommunity('deploy-scripts', [])).toBe('aegis');
    expect(classifyCommunity('infra-modules', [])).toBe('aegis');
  });

  it('routes UI communities to pixel', () => {
    expect(classifyCommunity('ui-components', [])).toBe('pixel');
    expect(classifyCommunity('render-layer', [])).toBe('pixel');
    expect(classifyCommunity('css-styles', [])).toBe('pixel');
    expect(classifyCommunity('layout-system', [])).toBe('pixel');
  });

  it('routes database communities to cipher', () => {
    expect(classifyCommunity('db-layer', [])).toBe('cipher');
    expect(classifyCommunity('schema-migrations', [])).toBe('cipher');
    expect(classifyCommunity('sql-queries', [])).toBe('cipher');
    expect(classifyCommunity('postgres-client', [])).toBe('cipher');
  });

  it('falls back to forge for unknown community names and files', () => {
    expect(classifyCommunity('misc-utilities', [])).toBe('forge');
    expect(classifyCommunity('random-module', [])).toBe('forge');
  });

  it('checks file paths when community name does not match', () => {
    expect(
      classifyCommunity('group-alpha', [
        'src/db/schema.sql',
        'src/db/client.ts',
      ]),
    ).toBe('cipher');

    expect(
      classifyCommunity('group-beta', [
        'src/renderer/chat/chat.css',
        'src/renderer/overlay/animation-loop.ts',
      ]),
    ).toBe('pixel');

    expect(
      classifyCommunity('group-gamma', [
        'tests/orchestrator/task-router.test.ts',
      ]),
    ).toBe('vigil');
  });
});

describe('buildCommunityOwnershipMap', () => {
  it('creates ownership entries for each community', () => {
    const communities = [
      { name: 'test-cluster', files: ['tests/foo.test.ts'], cohesion: 0.9 },
      { name: 'docker-infra', files: ['docker-compose.yml'], cohesion: 0.8 },
      { name: 'unknown-group', files: ['src/misc/util.ts'], cohesion: 0.5 },
    ];

    const map = buildCommunityOwnershipMap(communities);

    expect(map).toHaveLength(3);
    expect(map[0].communityName).toBe('test-cluster');
    expect(map[0].primaryAgent).toBe('vigil');
    expect(map[1].communityName).toBe('docker-infra');
    expect(map[1].primaryAgent).toBe('aegis');
    expect(map[2].communityName).toBe('unknown-group');
    expect(map[2].primaryAgent).toBe('forge');
  });

  it('preserves files in the ownership entry', () => {
    const files = ['src/db/schema.sql', 'src/db/client.ts'];
    const map = buildCommunityOwnershipMap([
      { name: 'data-layer', files, cohesion: 0.85 },
    ]);
    expect(map[0].files).toEqual(files);
  });
});

describe('routeByFiles', () => {
  const ownershipMap = buildCommunityOwnershipMap([
    {
      name: 'test-cluster',
      files: ['tests/foo.test.ts', 'tests/bar.test.ts'],
      cohesion: 0.9,
    },
    {
      name: 'db-cluster',
      files: ['src/db/schema.sql', 'src/db/client.ts', 'src/db/seed.sql'],
      cohesion: 0.8,
    },
    {
      name: 'ui-cluster',
      files: ['src/renderer/chat/chat.css', 'src/renderer/overlay/anim.ts'],
      cohesion: 0.7,
    },
  ]);

  it('returns the agent owning the community with the most file overlap', () => {
    const result = routeByFiles(
      ['tests/foo.test.ts', 'tests/bar.test.ts'],
      ownershipMap,
    );
    expect(result.suggestedAgent).toBe('vigil');
    expect(result.matchedCommunity).toBe('test-cluster');
  });

  it('returns confidence as matched_files / total_task_files', () => {
    // 2 of 3 task files match the db community
    const result = routeByFiles(
      ['src/db/schema.sql', 'src/db/client.ts', 'src/renderer/chat/chat.css'],
      ownershipMap,
    );
    expect(result.suggestedAgent).toBe('cipher');
    expect(result.confidence).toBeCloseTo(2 / 3);
  });

  it('handles empty task files gracefully', () => {
    const result = routeByFiles([], ownershipMap);
    expect(result.suggestedAgent).toBe('forge');
    expect(result.confidence).toBe(0);
    expect(result.matchedCommunity).toBeNull();
  });

  it('returns forge with confidence 0 when no overlap exists', () => {
    const result = routeByFiles(['src/nonexistent/file.ts'], ownershipMap);
    expect(result.suggestedAgent).toBe('forge');
    expect(result.confidence).toBe(0);
  });
});

describe('routeByDescription', () => {
  it('routes by keyword matching in description', () => {
    expect(
      routeByDescription('Fix the database migration script', 'fix'),
    ).toMatchObject({ suggestedAgent: 'cipher' });

    expect(
      routeByDescription('Update UI component styles', 'feat'),
    ).toMatchObject({ suggestedAgent: 'pixel' });

    expect(
      routeByDescription('Write unit tests for the auth module', 'test'),
    ).toMatchObject({ suggestedAgent: 'vigil' });
  });

  it('returns lower confidence than file-based routing (max 0.6)', () => {
    const descResult = routeByDescription('Deploy new docker container', 'ci');
    expect(descResult.confidence).toBeLessThanOrEqual(0.6);

    // File-based can return confidence up to 1.0
    const fileResult = routeByFiles(
      ['docker-compose.yml'],
      buildCommunityOwnershipMap([
        {
          name: 'ci-pipeline',
          files: ['docker-compose.yml'],
          cohesion: 0.9,
        },
      ]),
    );
    expect(fileResult.confidence).toBeGreaterThan(descResult.confidence);
  });

  it('falls back to forge with low confidence when no keywords match', () => {
    const result = routeByDescription('Something completely unrelated', 'misc');
    expect(result.suggestedAgent).toBe('forge');
    expect(result.confidence).toBe(0.3);
  });
});

describe('mergeRouteSignals', () => {
  it('prefers community routing when confidence > 0.7', () => {
    const communityResult = {
      suggestedAgent: 'vigil',
      confidence: 0.9,
      matchedCommunity: 'test-cluster',
      reason: 'Testing community',
    };
    const matrixResult = { agent: 'forge', score: 0.8 };

    const result = mergeRouteSignals(communityResult, matrixResult);
    expect(result.agent).toBe('vigil');
    expect(result.confidence).toBe(0.9);
  });

  it('prefers matrix routing when community confidence < 0.3', () => {
    const communityResult = {
      suggestedAgent: 'forge',
      confidence: 0.1,
      matchedCommunity: null,
      reason: 'No match',
    };
    const matrixResult = { agent: 'cipher', score: 0.75 };

    const result = mergeRouteSignals(communityResult, matrixResult);
    expect(result.agent).toBe('cipher');
    expect(result.confidence).toBe(0.75);
  });

  it('blends signals in the middle range (0.3–0.7)', () => {
    const communityResult = {
      suggestedAgent: 'pixel',
      confidence: 0.5,
      matchedCommunity: 'ui-cluster',
      reason: 'UI/Design community',
    };
    const matrixResult = { agent: 'forge', score: 0.9 };

    const result = mergeRouteSignals(communityResult, matrixResult);
    // Should pick one of them — not null and not undefined
    expect(['pixel', 'forge']).toContain(result.agent);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('handles null community result gracefully', () => {
    const result = mergeRouteSignals(null, { agent: 'blueprint', score: 0.8 });
    expect(result.agent).toBe('blueprint');
  });

  it('handles null matrix result gracefully', () => {
    const result = mergeRouteSignals(
      {
        suggestedAgent: 'herald',
        confidence: 0.6,
        matchedCommunity: null,
        reason: 'Documentation',
      },
      null,
    );
    expect(result.agent).toBe('herald');
  });
});

describe('COMMUNITY_AGENT_MAP', () => {
  it('has entries covering all key agents', () => {
    const agents = COMMUNITY_AGENT_MAP.map((e) => e.agent);
    const expectedAgents = [
      'vigil',
      'aegis',
      'pixel',
      'cipher',
      'forge',
      'herald',
      'blueprint',
      'scout',
    ];
    for (const agent of expectedAgents) {
      expect(agents).toContain(agent);
    }
  });
});
