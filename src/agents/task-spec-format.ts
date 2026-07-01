/**
 * Structured task specification format for Blueprint decomposition.
 * Each task is a 2-5 minute unit with exact entry/exit criteria.
 * Inspired by: Superpowers writing-plans skill.
 */

/** A structured task specification produced by Blueprint */
export interface TaskSpec {
    readonly title: string;
    readonly description: string;
    readonly estimatedMinutes: number;
    readonly entryConditions: readonly string[];
    readonly exitCriteria: readonly string[];
    readonly files: readonly string[];
    readonly dependencies: readonly string[];
    readonly taskType: string;
}

/** Build the decomposition prompt that instructs Blueprint to produce exact specs */
export function buildDecompositionPrompt(
    projectDescription: string,
    phase: string
): string {
    return [
        'TASK DECOMPOSITION: Produce exact, bite-sized task specifications.',
        '',
        'Each task MUST be a 2-5 minute unit of work with:',
        '- A clear, specific title (not vague)',
        '- Exact entry conditions (what must exist before starting)',
        '- Exact exit criteria (how to verify the task is done)',
        '- Specific files to create or modify',
        '- Dependencies on other tasks (by title reference)',
        '',
        `Project: ${projectDescription}`,
        `Current Phase: ${phase}`,
        '',
        'RULES:',
        '1. NO vague tasks like "implement the feature" or "set up the project"',
        '2. Each task must be independently verifiable',
        '3. Entry conditions reference specific files, functions, or states',
        '4. Exit criteria are binary: clearly passed or failed',
        '5. Prefer many small tasks over few large tasks',
        '6. Order tasks by dependency (independent tasks first)',
        '',
        'BAD task: "Implement user authentication"',
        'GOOD tasks:',
        '  1. "Create User interface in src/types/user.ts with id, email, passwordHash fields"',
        '     Entry: src/types/ directory exists',
        '     Exit: User interface exported, tsc passes',
        '  2. "Create hashPassword() in src/auth/password.ts using bcrypt"',
        '     Entry: User interface exists',
        '     Exit: hashPassword returns string, unit test passes',
        '  3. "Create verifyPassword() in src/auth/password.ts"',
        '     Entry: hashPassword() exists',
        '     Exit: verifyPassword returns boolean, unit test passes',
        '',
        'Output format — for EACH task:',
        '--- TASK ---',
        'TITLE: <specific title>',
        'TYPE: implement | fix-bug | refactor | create-api | create-ui | database-migration | write-tests | documentation',
        'ESTIMATED_MINUTES: <2-5>',
        'ENTRY_CONDITIONS:',
        '- <condition 1>',
        '- <condition 2>',
        'EXIT_CRITERIA:',
        '- <criterion 1>',
        '- <criterion 2>',
        'FILES:',
        '- <file path 1>',
        '- <file path 2>',
        'DEPENDS_ON:',
        '- <task title or "none">',
        'DESCRIPTION: <1-2 sentence description>',
        '--- END TASK ---',
    ].join('\n');
}

/** Parse task specs from Blueprint's AI output */
export function parseTaskSpecs(aiOutput: string): readonly TaskSpec[] {
    const taskBlocks = aiOutput.match(/--- TASK ---\s*\n([\s\S]*?)--- END TASK ---/g);
    if (taskBlocks === null) return [];

    return taskBlocks.map((block) => {
        const titleMatch = block.match(/TITLE:\s*(.+)/);
        const typeMatch = block.match(/TYPE:\s*(\S+)/);
        const minutesMatch = block.match(/ESTIMATED_MINUTES:\s*(\d+)/);
        const descMatch = block.match(/DESCRIPTION:\s*(.+)/);

        const entryConditions = extractListItems(block, 'ENTRY_CONDITIONS');
        const exitCriteria = extractListItems(block, 'EXIT_CRITERIA');
        const files = extractListItems(block, 'FILES');
        const dependencies = extractListItems(block, 'DEPENDS_ON')
            .filter(d => d.toLowerCase() !== 'none');

        return {
            title: titleMatch !== null ? titleMatch[1].trim() : 'Untitled task',
            description: descMatch !== null ? descMatch[1].trim() : '',
            estimatedMinutes: minutesMatch !== null ? parseInt(minutesMatch[1], 10) : 5,
            entryConditions,
            exitCriteria,
            files,
            dependencies,
            taskType: typeMatch !== null ? typeMatch[1].trim() : 'implement',
        };
    });
}

/** Extract bullet-point list items after a section header */
function extractListItems(block: string, sectionName: string): readonly string[] {
    const sectionRegex = new RegExp(
        `${sectionName}:\\s*\\n((?:- .+\\n?)*)`,
        'm'
    );
    const sectionMatch = block.match(sectionRegex);
    if (sectionMatch === null) return [];

    return sectionMatch[1]
        .split('\n')
        .map(line => line.replace(/^-\s*/, '').trim())
        .filter(line => line.length > 0);
}

/** Validate that task specs meet quality standards */
export function validateTaskSpecs(specs: readonly TaskSpec[]): readonly string[] {
    const warnings: string[] = [];

    for (const spec of specs) {
        if (spec.title.length < 10) {
            warnings.push(`Task "${spec.title}": title too vague (< 10 chars)`);
        }
        if (spec.estimatedMinutes < 1 || spec.estimatedMinutes > 15) {
            warnings.push(`Task "${spec.title}": estimate ${spec.estimatedMinutes}min outside 2-5min range`);
        }
        if (spec.exitCriteria.length === 0) {
            warnings.push(`Task "${spec.title}": missing exit criteria`);
        }
        if (spec.files.length === 0) {
            warnings.push(`Task "${spec.title}": no files specified`);
        }
    }

    // Check for circular dependencies
    const titleSet = new Set(specs.map(s => s.title));
    for (const spec of specs) {
        for (const dep of spec.dependencies) {
            if (!titleSet.has(dep)) {
                warnings.push(`Task "${spec.title}": dependency "${dep}" not found in task list`);
            }
        }
    }

    return warnings;
}
