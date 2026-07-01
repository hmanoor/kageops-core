// B-130: YAML Recipe Definitions + B-131: Parameterized Recipe Inputs

import type {
  RecipeDefinition,
  RecipeInstance,
  RecipeParam,
  RecipeStep,
  RecipeValidationError,
} from './recipe-types';

export type {
  RecipeDefinition,
  RecipeInstance,
  RecipeParam,
  RecipeStep,
  RecipeValidationError,
};

// ---------------------------------------------------------------------------
// YAML parsing (simple line-based, no external deps)
// ---------------------------------------------------------------------------

function parseValue(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== '') return num;
  // strip surrounding quotes
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseStringArray(lines: readonly string[], start: number, indent: number): { items: readonly string[]; end: number } {
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const lineIndent = line.search(/\S/);
    if (lineIndent < indent) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      items.push(String(parseValue(trimmed.slice(2))));
      i++;
    } else {
      break;
    }
  }
  return { items, end: i };
}

interface YamlBlock {
  readonly [key: string]: string | number | boolean | null | readonly string[] | readonly YamlBlock[];
}

function parseYamlBlocks(lines: readonly string[], start: number, indent: number): { blocks: readonly YamlBlock[]; end: number } {
  const blocks: YamlBlock[] = [];
  let i = start;
  let current: Record<string, unknown> | null = null;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const lineIndent = line.search(/\S/);
    if (lineIndent < indent) break;
    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) {
      if (current) blocks.push(current as unknown as YamlBlock);
      current = {};
      const rest = trimmed.slice(2);
      if (rest.includes(':')) {
        const colonIdx = rest.indexOf(':');
        const key = rest.slice(0, colonIdx).trim();
        const val = rest.slice(colonIdx + 1).trim();
        if (val === '') {
          // nested array
          const inner = parseStringArray(lines, i + 1, lineIndent + 2);
          (current as Record<string, unknown>)[key] = inner.items;
          i = inner.end;
          continue;
        }
        (current as Record<string, unknown>)[key] = parseValue(val);
      }
      i++;
    } else if (trimmed.includes(':') && current) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (val === '') {
        const inner = parseStringArray(lines, i + 1, lineIndent + 2);
        (current as Record<string, unknown>)[key] = inner.items;
        i = inner.end;
        continue;
      }
      (current as Record<string, unknown>)[key] = parseValue(val);
      i++;
    } else {
      break;
    }
  }
  if (current) blocks.push(current as unknown as YamlBlock);
  return { blocks, end: i };
}

export function parseRecipeYaml(yaml: string): RecipeDefinition | null {
  try {
    const lines = yaml.split('\n');
    const top: Record<string, unknown> = {};
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
      const indent = line.search(/\S/);
      if (indent !== 0) { i++; continue; }
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) { i++; continue; }
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();

      if (val === '') {
        // could be array or block list
        const nextLine = lines[i + 1] ?? '';
        const nextTrimmed = nextLine.trim();
        const nextIndent = nextLine.search(/\S/);
        if (nextTrimmed.startsWith('- ') && (key === 'tags')) {
          const arr = parseStringArray(lines, i + 1, nextIndent);
          top[key] = arr.items;
          i = arr.end;
        } else if (nextTrimmed.startsWith('- ')) {
          const blk = parseYamlBlocks(lines, i + 1, nextIndent);
          top[key] = blk.blocks;
          i = blk.end;
        } else {
          i++;
        }
      } else {
        top[key] = parseValue(val);
        i++;
      }
    }

    const asStr = (v: unknown): string => String(v ?? '');
    const params = ((top.params as readonly YamlBlock[] | undefined) ?? []).map((p): RecipeParam => ({
      name: asStr(p.name),
      type: asStr(p.type) as RecipeParam['type'],
      required: p.required === true || p.required === 'true' as unknown as boolean,
      defaultValue: (p.defaultValue ?? p.default ?? null) as string | number | boolean | null,
      options: (p.options as readonly string[] | undefined),
      description: asStr(p.description),
    }));
    const steps = ((top.steps as readonly YamlBlock[] | undefined) ?? []).map((s): RecipeStep => ({
      id: asStr(s.id),
      agentRole: asStr(s.agentRole),
      taskType: asStr(s.taskType),
      description: asStr(s.description),
      dependsOn: (s.dependsOn as readonly string[] | undefined) ?? [],
      timeout: s.timeout != null ? Number(s.timeout) : undefined,
    }));

    return {
      id: asStr(top.id),
      name: asStr(top.name),
      version: asStr(top.version),
      description: asStr(top.description),
      author: asStr(top.author),
      tags: (top.tags as readonly string[] | undefined) ?? [],
      params,
      steps,
      createdAt: asStr(top.createdAt),
      updatedAt: asStr(top.updatedAt),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// YAML serialization
// ---------------------------------------------------------------------------

export function serializeRecipeYaml(recipe: RecipeDefinition): string {
  const lines: string[] = [];
  const add = (k: string, v: string | number | boolean) => lines.push(`${k}: ${v}`);
  add('id', recipe.id);
  add('name', recipe.name);
  add('version', recipe.version);
  add('description', recipe.description);
  add('author', recipe.author);
  lines.push('tags:');
  recipe.tags.forEach(t => lines.push(`  - ${t}`));
  add('createdAt', recipe.createdAt);
  add('updatedAt', recipe.updatedAt);

  lines.push('params:');
  recipe.params.forEach(p => {
    lines.push(`  - name: ${p.name}`);
    lines.push(`    type: ${p.type}`);
    lines.push(`    required: ${p.required}`);
    lines.push(`    defaultValue: ${p.defaultValue ?? 'null'}`);
    if (p.options && p.options.length > 0) {
      lines.push('    options:');
      p.options.forEach(o => lines.push(`      - ${o}`));
    }
    lines.push(`    description: ${p.description}`);
  });

  lines.push('steps:');
  recipe.steps.forEach(s => {
    lines.push(`  - id: ${s.id}`);
    lines.push(`    agentRole: ${s.agentRole}`);
    lines.push(`    taskType: ${s.taskType}`);
    lines.push(`    description: ${s.description}`);
    if (s.dependsOn.length > 0) {
      lines.push('    dependsOn:');
      s.dependsOn.forEach(d => lines.push(`      - ${d}`));
    } else {
      lines.push('    dependsOn:');
    }
    if (s.timeout != null) lines.push(`    timeout: ${s.timeout}`);
  });

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateRecipe(recipe: RecipeDefinition): readonly RecipeValidationError[] {
  const errors: RecipeValidationError[] = [];
  if (!recipe.id) errors.push({ path: 'id', message: 'Recipe id is required' });
  if (!recipe.name) errors.push({ path: 'name', message: 'Recipe name is required' });
  if (!recipe.version) errors.push({ path: 'version', message: 'Recipe version is required' });

  const stepIds = new Set<string>();
  recipe.steps.forEach((s, i) => {
    if (!s.id) errors.push({ path: `steps[${i}].id`, message: 'Step id is required' });
    if (stepIds.has(s.id)) errors.push({ path: `steps[${i}].id`, message: `Duplicate step id: ${s.id}` });
    stepIds.add(s.id);
    if (!s.agentRole) errors.push({ path: `steps[${i}].agentRole`, message: 'agentRole is required' });
  });

  recipe.steps.forEach((s, i) => {
    s.dependsOn.forEach(dep => {
      if (!stepIds.has(dep)) {
        errors.push({ path: `steps[${i}].dependsOn`, message: `Invalid dependency: ${dep}` });
      }
    });
  });

  const cycles = detectCycles(recipe.steps);
  cycles.forEach(cycle => {
    errors.push({ path: 'steps', message: `Cycle detected: ${cycle.join(' -> ')}` });
  });

  const validParamTypes = new Set(['string', 'number', 'boolean', 'select']);
  recipe.params.forEach((p, i) => {
    if (!p.name) errors.push({ path: `params[${i}].name`, message: 'Param name is required' });
    if (!validParamTypes.has(p.type)) {
      errors.push({ path: `params[${i}].type`, message: `Invalid param type: ${p.type}` });
    }
    if (p.type === 'select' && (!p.options || p.options.length === 0)) {
      errors.push({ path: `params[${i}].options`, message: 'Select param must have options' });
    }
  });

  return errors;
}

export function validateParams(
  recipe: RecipeDefinition,
  values: Readonly<Record<string, string | number | boolean>>,
): readonly RecipeValidationError[] {
  const errors: RecipeValidationError[] = [];

  recipe.params.forEach(p => {
    const val = values[p.name];
    if (val === undefined || val === null) {
      if (p.required && p.defaultValue === null) {
        errors.push({ path: `params.${p.name}`, message: `Required param missing: ${p.name}` });
      }
      return;
    }
    const actualType = typeof val;
    if (p.type === 'string' && actualType !== 'string') {
      errors.push({ path: `params.${p.name}`, message: `Expected string, got ${actualType}` });
    } else if (p.type === 'number' && actualType !== 'number') {
      errors.push({ path: `params.${p.name}`, message: `Expected number, got ${actualType}` });
    } else if (p.type === 'boolean' && actualType !== 'boolean') {
      errors.push({ path: `params.${p.name}`, message: `Expected boolean, got ${actualType}` });
    } else if (p.type === 'select') {
      if (!p.options || !p.options.includes(String(val))) {
        errors.push({ path: `params.${p.name}`, message: `Value '${val}' not in options: ${(p.options ?? []).join(', ')}` });
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Param resolution
// ---------------------------------------------------------------------------

export function resolveParams(
  template: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = values[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

// ---------------------------------------------------------------------------
// Instance creation
// ---------------------------------------------------------------------------

export function instantiateRecipe(
  recipe: RecipeDefinition,
  paramValues: Readonly<Record<string, string | number | boolean>>,
): RecipeInstance {
  // Fill defaults for missing params
  const filled: Record<string, string | number | boolean> = { ...paramValues };
  recipe.params.forEach(p => {
    if (filled[p.name] === undefined && p.defaultValue !== null) {
      filled[p.name] = p.defaultValue;
    }
  });

  const resolvedSteps: readonly RecipeStep[] = recipe.steps.map(s => ({
    ...s,
    description: resolveParams(s.description, filled),
  }));

  return {
    recipeId: recipe.id,
    instanceId: `${recipe.id}-${Date.now()}`,
    paramValues: filled,
    resolvedSteps,
    status: 'pending',
    startedAt: null,
    completedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Dependency graph utilities
// ---------------------------------------------------------------------------

export function detectCycles(steps: readonly RecipeStep[]): readonly string[][] {
  const adj = new Map<string, readonly string[]>();
  steps.forEach(s => adj.set(s.id, s.dependsOn));

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    path.push(node);
    (adj.get(node) ?? []).forEach(dep => dfs(dep));
    path.pop();
    inStack.delete(node);
  }

  steps.forEach(s => { if (!visited.has(s.id)) dfs(s.id); });
  return cycles;
}

export function getExecutionOrder(steps: readonly RecipeStep[]): readonly string[] {
  const adj = new Map<string, readonly string[]>();
  steps.forEach(s => adj.set(s.id, s.dependsOn));

  const order: string[] = [];
  const visited = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    (adj.get(id) ?? []).forEach(dep => visit(dep));
    order.push(id);
  }

  steps.forEach(s => visit(s.id));
  return order;
}

export function getReadySteps(
  instance: RecipeInstance,
  completedStepIds: readonly string[],
): readonly string[] {
  const completed = new Set(completedStepIds);
  return instance.resolvedSteps
    .filter(s => !completed.has(s.id) && s.dependsOn.every(d => completed.has(d)))
    .map(s => s.id);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatRecipeSummary(recipe: RecipeDefinition): string {
  const lines: string[] = [
    `# ${recipe.name}`,
    '',
    recipe.description,
    '',
    `**Version:** ${recipe.version}  `,
    `**Author:** ${recipe.author}  `,
    `**Tags:** ${recipe.tags.join(', ')}`,
    '',
  ];

  if (recipe.params.length > 0) {
    lines.push('## Parameters', '');
    lines.push('| Name | Type | Required | Description |');
    lines.push('|------|------|----------|-------------|');
    recipe.params.forEach(p => {
      lines.push(`| ${p.name} | ${p.type} | ${p.required ? 'yes' : 'no'} | ${p.description} |`);
    });
    lines.push('');
  }

  if (recipe.steps.length > 0) {
    lines.push('## Steps', '');
    recipe.steps.forEach((s, i) => {
      const deps = s.dependsOn.length > 0 ? ` (depends on: ${s.dependsOn.join(', ')})` : '';
      lines.push(`${i + 1}. **${s.id}** [${s.agentRole}] — ${s.description}${deps}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Built-in recipes
// ---------------------------------------------------------------------------

export const BUILT_IN_RECIPES: readonly RecipeDefinition[] = [
  {
    id: 'web-app-scaffold',
    name: 'Web App Scaffold',
    version: '1.0.0',
    description: 'Scaffold a new web application with frontend, backend, and database.',
    author: 'KageOps',
    tags: ['web', 'scaffold', 'fullstack'],
    params: [
      { name: 'appName', type: 'string', required: true, defaultValue: null, description: 'Application name' },
      { name: 'framework', type: 'select', required: true, defaultValue: 'react', options: ['react', 'vue', 'svelte'], description: 'Frontend framework' },
      { name: 'includeAuth', type: 'boolean', required: false, defaultValue: true, description: 'Include authentication' },
    ],
    steps: [
      { id: 'research', agentRole: 'scout', taskType: 'research', description: 'Research best practices for {{framework}} app {{appName}}', dependsOn: [] },
      { id: 'design', agentRole: 'blueprint', taskType: 'architecture', description: 'Design architecture for {{appName}}', dependsOn: ['research'] },
      { id: 'scaffold', agentRole: 'forge', taskType: 'implementation', description: 'Generate {{framework}} project scaffold for {{appName}}', dependsOn: ['design'] },
      { id: 'review', agentRole: 'vigil', taskType: 'review', description: 'Review scaffolded code for {{appName}}', dependsOn: ['scaffold'] },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'api-endpoint',
    name: 'API Endpoint',
    version: '1.0.0',
    description: 'Create a new REST API endpoint with validation and tests.',
    author: 'KageOps',
    tags: ['api', 'backend', 'endpoint'],
    params: [
      { name: 'resource', type: 'string', required: true, defaultValue: null, description: 'Resource name (e.g., users)' },
      { name: 'method', type: 'select', required: true, defaultValue: 'GET', options: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method' },
    ],
    steps: [
      { id: 'spec', agentRole: 'blueprint', taskType: 'design', description: 'Design endpoint spec for {{method}} /{{resource}}', dependsOn: [] },
      { id: 'implement', agentRole: 'forge', taskType: 'implementation', description: 'Implement {{method}} /{{resource}} handler', dependsOn: ['spec'] },
      { id: 'test', agentRole: 'vigil', taskType: 'testing', description: 'Write tests for {{method}} /{{resource}}', dependsOn: ['implement'] },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'bug-fix-workflow',
    name: 'Bug Fix Workflow',
    version: '1.0.0',
    description: 'Structured workflow to diagnose and fix a bug.',
    author: 'KageOps',
    tags: ['bugfix', 'debugging', 'workflow'],
    params: [
      { name: 'bugDescription', type: 'string', required: true, defaultValue: null, description: 'Description of the bug' },
      { name: 'severity', type: 'select', required: true, defaultValue: 'medium', options: ['low', 'medium', 'high', 'critical'], description: 'Bug severity' },
    ],
    steps: [
      { id: 'reproduce', agentRole: 'scout', taskType: 'investigation', description: 'Reproduce and document bug: {{bugDescription}}', dependsOn: [] },
      { id: 'diagnose', agentRole: 'forge', taskType: 'analysis', description: 'Root cause analysis for: {{bugDescription}}', dependsOn: ['reproduce'] },
      { id: 'fix', agentRole: 'forge', taskType: 'implementation', description: 'Implement fix for {{severity}} bug', dependsOn: ['diagnose'] },
      { id: 'verify', agentRole: 'vigil', taskType: 'testing', description: 'Verify fix and add regression tests', dependsOn: ['fix'] },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];
