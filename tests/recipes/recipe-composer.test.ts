import { describe, it, expect } from 'vitest';
import type { RecipeDefinition } from '../../src/recipes/recipe-types';
import {
  flattenComposedRecipe,
  validateComposition,
  resolveSubRecipeParams,
  getComposedExecutionOrder,
  createMarketplaceIndex,
  searchMarketplace,
  filterByTag,
  sortByPopularity,
  sortByRating,
  publishRecipe,
  formatMarketplaceCard,
  SAMPLE_MARKETPLACE,
  type SubRecipeRef,
  type MarketplaceEntry,
} from '../../src/recipes/recipe-composer';

// --- Test Fixtures ---

const parentRecipe: RecipeDefinition = {
  id: 'parent',
  name: 'Parent Recipe',
  version: '1.0.0',
  description: 'A parent recipe',
  author: 'tester',
  tags: ['test'],
  params: [
    { name: 'appName', type: 'string', required: true, defaultValue: null, description: 'App name' },
    { name: 'port', type: 'number', required: false, defaultValue: 3000, description: 'Port' },
  ],
  steps: [
    { id: 'init', agentRole: 'Forge', taskType: 'scaffold', description: 'Init project', dependsOn: [] },
    { id: 'config', agentRole: 'Forge', taskType: 'config', description: 'Configure', dependsOn: ['init'] },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const childRecipe: RecipeDefinition = {
  id: 'child',
  name: 'Child Recipe',
  version: '1.0.0',
  description: 'A child recipe',
  author: 'tester',
  tags: ['sub'],
  params: [
    { name: 'name', type: 'string', required: true, defaultValue: null, description: 'Name' },
  ],
  steps: [
    { id: 'build', agentRole: 'Forge', taskType: 'build', description: 'Build child', dependsOn: [] },
    { id: 'test', agentRole: 'Vigil', taskType: 'test', description: 'Test child', dependsOn: ['build'] },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const subRef: SubRecipeRef = {
  recipeId: 'child',
  alias: 'backend',
  paramMapping: { name: 'appName' },
};

const availableMap: ReadonlyMap<string, RecipeDefinition> = new Map([['child', childRecipe]]);

// --- Composition Tests ---

describe('flattenComposedRecipe', () => {
  it('expands sub-recipes with aliased step IDs', () => {
    const composed = flattenComposedRecipe(parentRecipe, availableMap, [subRef]);
    const ids = composed.flattenedSteps.map((s) => s.resolvedId);
    expect(ids).toContain('root.init');
    expect(ids).toContain('root.config');
    expect(ids).toContain('backend.build');
    expect(ids).toContain('backend.test');
  });

  it('remaps dependsOn with alias prefix', () => {
    const composed = flattenComposedRecipe(parentRecipe, availableMap, [subRef]);
    const testStep = composed.flattenedSteps.find((s) => s.resolvedId === 'backend.test');
    expect(testStep?.dependsOn).toEqual(['backend.build']);
  });

  it('preserves parent metadata', () => {
    const composed = flattenComposedRecipe(parentRecipe, availableMap, [subRef]);
    expect(composed.id).toBe('parent');
    expect(composed.name).toBe('Parent Recipe');
    expect(composed.subRecipes).toEqual([subRef]);
  });
});

describe('validateComposition', () => {
  it('returns empty array for valid composition', () => {
    const errors = validateComposition(parentRecipe, [subRef], availableMap);
    expect(errors).toEqual([]);
  });

  it('catches missing sub-recipe refs', () => {
    const badRef: SubRecipeRef = { recipeId: 'nonexistent', alias: 'bad', paramMapping: {} };
    const errors = validateComposition(parentRecipe, [badRef], availableMap);
    expect(errors.some((e) => e.includes('not found'))).toBe(true);
  });

  it('catches invalid param mappings', () => {
    const badRef: SubRecipeRef = {
      recipeId: 'child',
      alias: 'x',
      paramMapping: { bogusChild: 'bogusParent' },
    };
    const errors = validateComposition(parentRecipe, [badRef], availableMap);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('catches duplicate aliases', () => {
    const errors = validateComposition(parentRecipe, [subRef, subRef], availableMap);
    expect(errors.some((e) => e.includes('Duplicate alias'))).toBe(true);
  });

  it('catches circular references', () => {
    const selfRef: SubRecipeRef = { recipeId: 'parent', alias: 'loop', paramMapping: {} };
    const withParent = new Map([...availableMap, ['parent', parentRecipe]]);
    const errors = validateComposition(parentRecipe, [selfRef], withParent);
    expect(errors.some((e) => e.includes('Circular'))).toBe(true);
  });
});

describe('resolveSubRecipeParams', () => {
  it.each([
    [{ name: 'appName' }, { appName: 'MyApp', port: 3000 }, { name: 'MyApp' }],
    [{ name: 'appName' }, { appName: 'Test' }, { name: 'Test' }],
    [{ x: 'missing' }, { appName: 'Foo' }, {}],
  ])('maps parent values to child via paramMapping %#', (mapping, parentValues, expected) => {
    const ref: SubRecipeRef = { recipeId: 'child', alias: 'a', paramMapping: mapping };
    expect(resolveSubRecipeParams(ref, parentValues)).toEqual(expected);
  });
});

describe('getComposedExecutionOrder', () => {
  it('returns valid topological order', () => {
    const composed = flattenComposedRecipe(parentRecipe, availableMap, [subRef]);
    const order = getComposedExecutionOrder(composed);
    expect(order.indexOf('root.init')).toBeLessThan(order.indexOf('root.config'));
    expect(order.indexOf('backend.build')).toBeLessThan(order.indexOf('backend.test'));
  });

  it('includes all steps', () => {
    const composed = flattenComposedRecipe(parentRecipe, availableMap, [subRef]);
    const order = getComposedExecutionOrder(composed);
    expect(order).toHaveLength(4);
  });
});

// --- Marketplace Tests ---

describe('searchMarketplace', () => {
  it.each([
    ['Web', 1],
    ['api', 2],
    ['cli', 1],
    ['nonexistent', 0],
  ])('finds entries matching "%s" (%i results)', (query, expectedCount) => {
    const result = searchMarketplace(SAMPLE_MARKETPLACE, query);
    expect(result.entries).toHaveLength(expectedCount);
    expect(result.query).toBe(query);
    expect(result.totalMatches).toBe(expectedCount);
  });
});

describe('filterByTag', () => {
  it('returns entries matching tag', () => {
    const results = filterByTag(SAMPLE_MARKETPLACE, 'api');
    expect(results.length).toBe(2);
    expect(results.every((e) => e.tags.includes('api'))).toBe(true);
  });

  it('returns empty for unknown tag', () => {
    expect(filterByTag(SAMPLE_MARKETPLACE, 'unknown')).toEqual([]);
  });
});

describe('sortByPopularity', () => {
  it('sorts by downloads desc then rating desc', () => {
    const sorted = sortByPopularity(SAMPLE_MARKETPLACE.entries);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      expect(prev.downloads >= curr.downloads).toBe(true);
    }
  });
});

describe('sortByRating', () => {
  it('sorts by rating desc then downloads desc', () => {
    const sorted = sortByRating(SAMPLE_MARKETPLACE.entries);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].rating >= sorted[i].rating).toBe(true);
    }
  });
});

describe('publishRecipe', () => {
  it('creates valid marketplace entry with zero downloads', () => {
    const entry = publishRecipe(parentRecipe, 'author1');
    expect(entry.recipeId).toBe('parent');
    expect(entry.author).toBe('author1');
    expect(entry.downloads).toBe(0);
    expect(entry.rating).toBe(0);
    expect(entry.verified).toBe(false);
  });
});

describe('createMarketplaceIndex', () => {
  it('creates index sorted by publishedAt desc', () => {
    const entries: MarketplaceEntry[] = [
      { ...SAMPLE_MARKETPLACE.entries[0], publishedAt: '2026-01-01T00:00:00Z' },
      { ...SAMPLE_MARKETPLACE.entries[1], publishedAt: '2026-03-01T00:00:00Z' },
    ];
    const index = createMarketplaceIndex(entries);
    expect(index.entries[0].publishedAt).toBe('2026-03-01T00:00:00Z');
    expect(index.totalCount).toBe(2);
  });
});

describe('formatMarketplaceCard', () => {
  it('produces readable markdown with name and rating', () => {
    const card = formatMarketplaceCard(SAMPLE_MARKETPLACE.entries[0]);
    expect(card).toContain('## Full-Stack Web App');
    expect(card).toContain('[verified]');
    expect(card).toContain('4.5');
    expect(card).toContain('1200');
  });

  it('omits verified badge for unverified entries', () => {
    const card = formatMarketplaceCard(SAMPLE_MARKETPLACE.entries[1]);
    expect(card).not.toContain('[verified]');
  });
});

describe('SAMPLE_MARKETPLACE', () => {
  it('has valid structure with 5 entries', () => {
    expect(SAMPLE_MARKETPLACE.entries).toHaveLength(5);
    expect(SAMPLE_MARKETPLACE.totalCount).toBe(5);
    for (const entry of SAMPLE_MARKETPLACE.entries) {
      expect(entry.recipeId).toBeTruthy();
      expect(entry.tags.length).toBeGreaterThan(0);
      expect(typeof entry.downloads).toBe('number');
      expect(typeof entry.rating).toBe('number');
    }
  });
});
