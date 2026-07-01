// Recipe type definitions for B-130 / B-131

export interface RecipeStep {
  readonly id: string;
  readonly agentRole: string;
  readonly taskType: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly timeout?: number;
}

export interface RecipeParam {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'select';
  readonly required: boolean;
  readonly defaultValue: string | number | boolean | null;
  readonly options?: readonly string[];
  readonly description: string;
}

export interface RecipeDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly tags: readonly string[];
  readonly params: readonly RecipeParam[];
  readonly steps: readonly RecipeStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecipeInstance {
  readonly recipeId: string;
  readonly instanceId: string;
  readonly paramValues: Readonly<Record<string, string | number | boolean>>;
  readonly resolvedSteps: readonly RecipeStep[];
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface RecipeValidationError {
  readonly path: string;
  readonly message: string;
}
