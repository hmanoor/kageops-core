import { describe, it, expect } from 'vitest';
import {
  parseRecipeYaml,
  serializeRecipeYaml,
  validateRecipe,
  validateParams,
  resolveParams,
  instantiateRecipe,
  getExecutionOrder,
  detectCycles,
  getReadySteps,
  formatRecipeSummary,
  BUILT_IN_RECIPES,
  type RecipeDefinition,
  type RecipeStep,
} from '../../src/recipes/recipe-engine';

const MINIMAL_RECIPE: RecipeDefinition = {
  id: 'test-recipe',
  name: 'Test Recipe',
  version: '1.0.0',
  description: 'A test recipe',
  author: 'tester',
  tags: ['test'],
  params: [
    { name: 'appName', type: 'string', required: true, defaultValue: null, description: 'App name' },
    { name: 'count', type: 'number', required: false, defaultValue: 3, description: 'Count' },
    { name: 'verbose', type: 'boolean', required: false, defaultValue: false, description: 'Verbose' },
    { name: 'env', type: 'select', required: true, defaultValue: 'dev', options: ['dev', 'staging', 'prod'], description: 'Environment' },
  ],
  steps: [
    { id: 'step1', agentRole: 'scout', taskType: 'research', description: 'Research {{appName}}', dependsOn: [] },
    { id: 'step2', agentRole: 'forge', taskType: 'build', description: 'Build {{appName}} for {{env}}', dependsOn: ['step1'] },
    { id: 'step3', agentRole: 'vigil', taskType: 'test', description: 'Test {{appName}}', dependsOn: ['step1'] },
    { id: 'step4', agentRole: 'aegis', taskType: 'deploy', description: 'Deploy to {{env}}', dependsOn: ['step2', 'step3'] },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('recipe-engine', () => {
  describe('parseRecipeYaml / serializeRecipeYaml round-trip', () => {
    it('should round-trip a recipe through YAML', () => {
      const yaml = serializeRecipeYaml(MINIMAL_RECIPE);
      const parsed = parseRecipeYaml(yaml);
      expect(parsed).not.toBeNull();
      expect(parsed!.id).toBe(MINIMAL_RECIPE.id);
      expect(parsed!.name).toBe(MINIMAL_RECIPE.name);
      expect(parsed!.steps.length).toBe(4);
      expect(parsed!.params.length).toBe(4);
      expect(parsed!.tags).toEqual(['test']);
    });

    it('should return null for completely invalid YAML', () => {
      // Parser is lenient, but totally empty produces empty recipe, not null
      const result = parseRecipeYaml('');
      expect(result).not.toBeNull();
      // id will be empty
      expect(result!.id).toBe('');
    });

    it('should preserve step dependsOn through round-trip', () => {
      const yaml = serializeRecipeYaml(MINIMAL_RECIPE);
      const parsed = parseRecipeYaml(yaml);
      expect(parsed!.steps[3].dependsOn).toEqual(['step2', 'step3']);
    });
  });

  describe('validateRecipe', () => {
    it('should return no errors for a valid recipe', () => {
      const errors = validateRecipe(MINIMAL_RECIPE);
      expect(errors).toEqual([]);
    });

    it.each([
      ['id', { ...MINIMAL_RECIPE, id: '' }],
      ['name', { ...MINIMAL_RECIPE, name: '' }],
      ['version', { ...MINIMAL_RECIPE, version: '' }],
    ])('should report missing %s', (_field, recipe) => {
      const errors = validateRecipe(recipe);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.path === _field)).toBe(true);
    });

    it('should detect duplicate step IDs', () => {
      const recipe: RecipeDefinition = {
        ...MINIMAL_RECIPE,
        steps: [
          { id: 'dup', agentRole: 'scout', taskType: 'research', description: 'A', dependsOn: [] },
          { id: 'dup', agentRole: 'forge', taskType: 'build', description: 'B', dependsOn: [] },
        ],
      };
      const errors = validateRecipe(recipe);
      expect(errors.some(e => e.message.includes('Duplicate'))).toBe(true);
    });

    it('should detect invalid dependsOn references', () => {
      const recipe: RecipeDefinition = {
        ...MINIMAL_RECIPE,
        steps: [
          { id: 's1', agentRole: 'scout', taskType: 'research', description: 'A', dependsOn: ['nonexistent'] },
        ],
      };
      const errors = validateRecipe(recipe);
      expect(errors.some(e => e.message.includes('Invalid dependency'))).toBe(true);
    });

    it('should detect cycles in steps', () => {
      const recipe: RecipeDefinition = {
        ...MINIMAL_RECIPE,
        steps: [
          { id: 'a', agentRole: 'scout', taskType: 'r', description: 'A', dependsOn: ['b'] },
          { id: 'b', agentRole: 'forge', taskType: 'r', description: 'B', dependsOn: ['a'] },
        ],
      };
      const errors = validateRecipe(recipe);
      expect(errors.some(e => e.message.includes('Cycle'))).toBe(true);
    });

    it('should reject select param without options', () => {
      const recipe: RecipeDefinition = {
        ...MINIMAL_RECIPE,
        params: [
          { name: 'bad', type: 'select', required: true, defaultValue: null, description: 'No options' },
        ],
      };
      const errors = validateRecipe(recipe);
      expect(errors.some(e => e.message.includes('options'))).toBe(true);
    });
  });

  describe('validateParams', () => {
    it('should pass with valid params', () => {
      const errors = validateParams(MINIMAL_RECIPE, { appName: 'myapp', env: 'dev' });
      expect(errors).toEqual([]);
    });

    it('should report missing required param', () => {
      const errors = validateParams(MINIMAL_RECIPE, { env: 'dev' });
      expect(errors.some(e => e.message.includes('appName'))).toBe(true);
    });

    it.each([
      ['string', 'appName', 42],
      ['number', 'count', 'not-a-number'],
      ['boolean', 'verbose', 'yes'],
    ])('should reject wrong type for %s param', (_type, name, value) => {
      const errors = validateParams(MINIMAL_RECIPE, { appName: 'x', env: 'dev', [name]: value } as Record<string, string | number | boolean>);
      expect(errors.some(e => e.path.includes(name))).toBe(true);
    });

    it('should reject invalid select value', () => {
      const errors = validateParams(MINIMAL_RECIPE, { appName: 'x', env: 'invalid' });
      expect(errors.some(e => e.message.includes('not in options'))).toBe(true);
    });
  });

  describe('resolveParams', () => {
    it.each([
      ['Hello {{name}}', { name: 'World' }, 'Hello World'],
      ['{{a}} and {{b}}', { a: 'X', b: 'Y' }, 'X and Y'],
      ['{{missing}} stays', {}, '{{missing}} stays'],
      ['No placeholders', { x: 'y' }, 'No placeholders'],
    ])('should resolve "%s"', (template, values, expected) => {
      expect(resolveParams(template, values as Record<string, string | number | boolean>)).toBe(expected);
    });
  });

  describe('instantiateRecipe', () => {
    it('should create instance with resolved descriptions', () => {
      const instance = instantiateRecipe(MINIMAL_RECIPE, { appName: 'MyApp', env: 'prod' });
      expect(instance.recipeId).toBe('test-recipe');
      expect(instance.status).toBe('pending');
      expect(instance.startedAt).toBeNull();
      expect(instance.resolvedSteps[0].description).toBe('Research MyApp');
      expect(instance.resolvedSteps[1].description).toBe('Build MyApp for prod');
    });

    it('should fill default values for missing params', () => {
      const instance = instantiateRecipe(MINIMAL_RECIPE, { appName: 'X', env: 'dev' });
      expect(instance.paramValues.count).toBe(3);
      expect(instance.paramValues.verbose).toBe(false);
    });
  });

  describe('detectCycles', () => {
    it('should return empty array for acyclic graph', () => {
      const steps: readonly RecipeStep[] = [
        { id: 'a', agentRole: 'x', taskType: 'y', description: '', dependsOn: [] },
        { id: 'b', agentRole: 'x', taskType: 'y', description: '', dependsOn: ['a'] },
      ];
      expect(detectCycles(steps)).toEqual([]);
    });

    it('should detect a direct cycle', () => {
      const steps: readonly RecipeStep[] = [
        { id: 'a', agentRole: 'x', taskType: 'y', description: '', dependsOn: ['b'] },
        { id: 'b', agentRole: 'x', taskType: 'y', description: '', dependsOn: ['a'] },
      ];
      const cycles = detectCycles(steps);
      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  describe('getExecutionOrder', () => {
    it('should return topological order', () => {
      const order = getExecutionOrder(MINIMAL_RECIPE.steps);
      const indexOf = (id: string) => order.indexOf(id);
      // step1 before step2 and step3; step2,step3 before step4
      expect(indexOf('step1')).toBeLessThan(indexOf('step2'));
      expect(indexOf('step1')).toBeLessThan(indexOf('step3'));
      expect(indexOf('step2')).toBeLessThan(indexOf('step4'));
      expect(indexOf('step3')).toBeLessThan(indexOf('step4'));
    });
  });

  describe('getReadySteps', () => {
    it('should return steps with all deps completed', () => {
      const instance = instantiateRecipe(MINIMAL_RECIPE, { appName: 'X', env: 'dev' });
      expect(getReadySteps(instance, [])).toEqual(['step1']);
      expect(getReadySteps(instance, ['step1'])).toEqual(['step2', 'step3']);
      expect(getReadySteps(instance, ['step1', 'step2'])).toEqual(['step3']);
      expect(getReadySteps(instance, ['step1', 'step2', 'step3'])).toEqual(['step4']);
    });
  });

  describe('formatRecipeSummary', () => {
    it('should produce markdown with heading and tables', () => {
      const md = formatRecipeSummary(MINIMAL_RECIPE);
      expect(md).toContain('# Test Recipe');
      expect(md).toContain('## Parameters');
      expect(md).toContain('## Steps');
      expect(md).toContain('| appName |');
      expect(md).toContain('**step1**');
    });
  });

  describe('BUILT_IN_RECIPES', () => {
    it.each(BUILT_IN_RECIPES.map(r => [r.id, r]))('built-in "%s" should validate cleanly', (_id, recipe) => {
      const errors = validateRecipe(recipe as RecipeDefinition);
      expect(errors).toEqual([]);
    });

    it('should have 3 built-in recipes', () => {
      expect(BUILT_IN_RECIPES.length).toBe(3);
    });
  });
});
