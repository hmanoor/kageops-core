// B-132: Sub-Recipe Composition & B-133: Recipe Marketplace

import type { RecipeDefinition, RecipeStep } from './recipe-types';

// --- Sub-Recipe Composition Types ---

export interface SubRecipeRef {
  readonly recipeId: string;
  readonly alias: string;
  readonly paramMapping: Readonly<Record<string, string>>;
}

export interface FlattenedStep {
  readonly originalStepId: string;
  readonly sourceRecipeId: string;
  readonly sourceAlias: string;
  readonly agentRole: string;
  readonly taskType: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly resolvedId: string;
}

export interface ComposedRecipe {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly tags: readonly string[];
  readonly subRecipes: readonly SubRecipeRef[];
  readonly flattenedSteps: readonly FlattenedStep[];
}

// --- Marketplace Types ---

export interface MarketplaceEntry {
  readonly recipeId: string;
  readonly name: string;
  readonly author: string;
  readonly version: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly downloads: number;
  readonly rating: number;
  readonly publishedAt: string;
  readonly verified: boolean;
}

export interface MarketplaceIndex {
  readonly entries: readonly MarketplaceEntry[];
  readonly lastUpdated: string;
  readonly totalCount: number;
}

export interface MarketplaceSearchResult {
  readonly entries: readonly MarketplaceEntry[];
  readonly query: string;
  readonly totalMatches: number;
}

// --- Sub-Recipe Composition Functions ---

function flattenStep(step: RecipeStep, alias: string, recipeId: string): FlattenedStep {
  const resolvedId = `${alias}.${step.id}`;
  return {
    originalStepId: step.id,
    sourceRecipeId: recipeId,
    sourceAlias: alias,
    agentRole: step.agentRole,
    taskType: step.taskType,
    description: step.description,
    dependsOn: step.dependsOn.map((dep) => `${alias}.${dep}`),
    resolvedId,
  };
}

export function resolveSubRecipeParams(
  ref: SubRecipeRef,
  parentValues: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  const result: Record<string, string | number | boolean> = {};
  for (const [childParam, parentParam] of Object.entries(ref.paramMapping)) {
    if (parentParam in parentValues) {
      result[childParam] = parentValues[parentParam];
    }
  }
  return result;
}

export function validateComposition(
  parent: RecipeDefinition,
  refs: readonly SubRecipeRef[],
  available: ReadonlyMap<string, RecipeDefinition>,
): readonly string[] {
  const errors: string[] = [];
  const aliases = new Set<string>();

  for (const ref of refs) {
    if (aliases.has(ref.alias)) {
      errors.push(`Duplicate alias: "${ref.alias}"`);
    }
    aliases.add(ref.alias);

    if (!available.has(ref.recipeId)) {
      errors.push(`Sub-recipe not found: "${ref.recipeId}"`);
      continue;
    }

    const child = available.get(ref.recipeId)!;
    const parentParamNames = new Set(parent.params.map((p) => p.name));
    const childParamNames = new Set(child.params.map((p) => p.name));

    for (const [childParam, parentParam] of Object.entries(ref.paramMapping)) {
      if (!parentParamNames.has(parentParam)) {
        errors.push(`Parent param "${parentParam}" not found for alias "${ref.alias}"`);
      }
      if (!childParamNames.has(childParam)) {
        errors.push(`Child param "${childParam}" not found in recipe "${ref.recipeId}"`);
      }
    }

    // Circular check: sub-recipe must not reference parent
    if (ref.recipeId === parent.id) {
      errors.push(`Circular reference: "${ref.alias}" references parent recipe`);
    }
  }

  return errors;
}

export function flattenComposedRecipe(
  parent: RecipeDefinition,
  subRecipes: ReadonlyMap<string, RecipeDefinition>,
  refs: readonly SubRecipeRef[],
): ComposedRecipe {
  const parentSteps: readonly FlattenedStep[] = parent.steps.map((step) => ({
    originalStepId: step.id,
    sourceRecipeId: parent.id,
    sourceAlias: 'root',
    agentRole: step.agentRole,
    taskType: step.taskType,
    description: step.description,
    dependsOn: step.dependsOn.map((dep) => `root.${dep}`),
    resolvedId: `root.${step.id}`,
  }));

  const subSteps: FlattenedStep[] = [];
  for (const ref of refs) {
    const recipe = subRecipes.get(ref.recipeId);
    if (recipe) {
      for (const step of recipe.steps) {
        subSteps.push(flattenStep(step, ref.alias, ref.recipeId));
      }
    }
  }

  return {
    id: parent.id,
    name: parent.name,
    version: parent.version,
    description: parent.description,
    author: parent.author,
    tags: parent.tags,
    subRecipes: refs,
    flattenedSteps: [...parentSteps, ...subSteps],
  };
}

export function getComposedExecutionOrder(composed: ComposedRecipe): readonly string[] {
  const steps = composed.flattenedSteps;
  const idSet = new Set(steps.map((s) => s.resolvedId));
  const adjList = new Map<string, readonly string[]>();
  const inDegree = new Map<string, number>();

  for (const step of steps) {
    const validDeps = step.dependsOn.filter((d) => idSet.has(d));
    adjList.set(step.resolvedId, validDeps);
    inDegree.set(step.resolvedId, validDeps.length);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const step of steps) {
      if (adjList.get(step.resolvedId)?.includes(current)) {
        const newDeg = (inDegree.get(step.resolvedId) ?? 0) - 1;
        inDegree.set(step.resolvedId, newDeg);
        if (newDeg === 0) queue.push(step.resolvedId);
      }
    }
  }

  return order;
}

// --- Marketplace Functions ---

export function createMarketplaceIndex(entries: readonly MarketplaceEntry[]): MarketplaceIndex {
  const sorted = [...entries].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return {
    entries: sorted,
    lastUpdated: new Date().toISOString(),
    totalCount: sorted.length,
  };
}

export function searchMarketplace(
  index: MarketplaceIndex,
  query: string,
): MarketplaceSearchResult {
  const lower = query.toLowerCase();
  const matched = index.entries.filter(
    (e) =>
      e.name.toLowerCase().includes(lower) ||
      e.description.toLowerCase().includes(lower) ||
      e.tags.some((t) => t.toLowerCase().includes(lower)),
  );
  return { entries: matched, query, totalMatches: matched.length };
}

export function filterByTag(index: MarketplaceIndex, tag: string): readonly MarketplaceEntry[] {
  const lower = tag.toLowerCase();
  return index.entries.filter((e) => e.tags.some((t) => t.toLowerCase() === lower));
}

export function sortByPopularity(
  entries: readonly MarketplaceEntry[],
): readonly MarketplaceEntry[] {
  return [...entries].sort((a, b) => b.downloads - a.downloads || b.rating - a.rating);
}

export function sortByRating(entries: readonly MarketplaceEntry[]): readonly MarketplaceEntry[] {
  return [...entries].sort((a, b) => b.rating - a.rating || b.downloads - a.downloads);
}

export function publishRecipe(recipe: RecipeDefinition, author: string): MarketplaceEntry {
  return {
    recipeId: recipe.id,
    name: recipe.name,
    author,
    version: recipe.version,
    description: recipe.description,
    tags: recipe.tags,
    downloads: 0,
    rating: 0,
    publishedAt: new Date().toISOString(),
    verified: false,
  };
}

export function formatMarketplaceCard(entry: MarketplaceEntry): string {
  const stars = entry.rating.toFixed(1);
  const verified = entry.verified ? ' [verified]' : '';
  return [
    `## ${entry.name}${verified}`,
    `*by ${entry.author} — v${entry.version}*`,
    '',
    entry.description,
    '',
    `**Tags:** ${entry.tags.join(', ')}`,
    `**Downloads:** ${entry.downloads} | **Rating:** ${stars}/5`,
  ].join('\n');
}

// --- Sample Data ---

export const SAMPLE_MARKETPLACE: MarketplaceIndex = {
  entries: [
    {
      recipeId: 'recipe-web-app',
      name: 'Full-Stack Web App',
      author: 'kageops',
      version: '1.0.0',
      description: 'End-to-end web application with API and frontend',
      tags: ['web', 'fullstack', 'api'],
      downloads: 1200,
      rating: 4.5,
      publishedAt: '2026-01-15T00:00:00Z',
      verified: true,
    },
    {
      recipeId: 'recipe-cli-tool',
      name: 'CLI Tool Starter',
      author: 'community',
      version: '0.9.0',
      description: 'Command-line tool with argument parsing and tests',
      tags: ['cli', 'tool', 'starter'],
      downloads: 800,
      rating: 4.2,
      publishedAt: '2026-02-10T00:00:00Z',
      verified: false,
    },
    {
      recipeId: 'recipe-data-pipeline',
      name: 'Data Pipeline',
      author: 'kageops',
      version: '1.1.0',
      description: 'ETL pipeline with validation and monitoring',
      tags: ['data', 'etl', 'pipeline'],
      downloads: 600,
      rating: 4.7,
      publishedAt: '2026-03-01T00:00:00Z',
      verified: true,
    },
    {
      recipeId: 'recipe-mobile-app',
      name: 'Mobile App Template',
      author: 'community',
      version: '0.5.0',
      description: 'Cross-platform mobile app with navigation and state',
      tags: ['mobile', 'app', 'cross-platform'],
      downloads: 400,
      rating: 3.8,
      publishedAt: '2026-03-10T00:00:00Z',
      verified: false,
    },
    {
      recipeId: 'recipe-microservice',
      name: 'Microservice Blueprint',
      author: 'kageops',
      version: '2.0.0',
      description: 'Production-ready microservice with health checks and logging',
      tags: ['microservice', 'api', 'production'],
      downloads: 950,
      rating: 4.6,
      publishedAt: '2026-03-20T00:00:00Z',
      verified: true,
    },
  ],
  lastUpdated: '2026-04-01T00:00:00Z',
  totalCount: 5,
};
