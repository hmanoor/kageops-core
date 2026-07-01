import { describe, it, expect } from 'vitest';
import {
    buildDecompositionPrompt,
    parseTaskSpecs,
    validateTaskSpecs,
    TaskSpec,
} from '../../src/agents/task-spec-format';

describe('buildDecompositionPrompt', () => {
    it('contains project description and phase', () => {
        const prompt = buildDecompositionPrompt('My cool project', 'Development');
        expect(prompt).toContain('Project: My cool project');
        expect(prompt).toContain('Current Phase: Development');
    });

    it('includes decomposition rules and format instructions', () => {
        const prompt = buildDecompositionPrompt('test', 'Discovery');
        expect(prompt).toContain('--- TASK ---');
        expect(prompt).toContain('--- END TASK ---');
        expect(prompt).toContain('EXIT_CRITERIA');
        expect(prompt).toContain('ENTRY_CONDITIONS');
    });
});

const WELL_FORMED_OUTPUT = `
Some preamble text from the AI.

--- TASK ---
TITLE: Create User interface in src/types/user.ts
TYPE: implement
ESTIMATED_MINUTES: 3
ENTRY_CONDITIONS:
- src/types/ directory exists
- TypeScript project is initialized
EXIT_CRITERIA:
- User interface is exported from src/types/user.ts
- tsc compiles without errors
FILES:
- src/types/user.ts
DEPENDS_ON:
- none
DESCRIPTION: Define the User interface with id, email, and passwordHash fields.
--- END TASK ---

--- TASK ---
TITLE: Create hashPassword function in src/auth/password.ts
TYPE: implement
ESTIMATED_MINUTES: 4
ENTRY_CONDITIONS:
- User interface exists in src/types/user.ts
EXIT_CRITERIA:
- hashPassword returns a string
- Unit test for hashPassword passes
FILES:
- src/auth/password.ts
- tests/auth/password.test.ts
DEPENDS_ON:
- Create User interface in src/types/user.ts
DESCRIPTION: Implement password hashing using bcrypt.
--- END TASK ---
`;

describe('parseTaskSpecs', () => {
    it('parses multiple well-formed task blocks', () => {
        const specs = parseTaskSpecs(WELL_FORMED_OUTPUT);
        expect(specs).toHaveLength(2);
    });

    it('returns empty array for malformed input', () => {
        expect(parseTaskSpecs('no task blocks here')).toEqual([]);
        expect(parseTaskSpecs('')).toEqual([]);
    });

    it('extracts all fields correctly from first task', () => {
        const specs = parseTaskSpecs(WELL_FORMED_OUTPUT);
        const first = specs[0];

        expect(first.title).toBe('Create User interface in src/types/user.ts');
        expect(first.taskType).toBe('implement');
        expect(first.estimatedMinutes).toBe(3);
        expect(first.description).toBe('Define the User interface with id, email, and passwordHash fields.');
        expect(first.entryConditions).toEqual([
            'src/types/ directory exists',
            'TypeScript project is initialized',
        ]);
        expect(first.exitCriteria).toEqual([
            'User interface is exported from src/types/user.ts',
            'tsc compiles without errors',
        ]);
        expect(first.files).toEqual(['src/types/user.ts']);
        expect(first.dependencies).toEqual([]);  // "none" is filtered out
    });

    it('extracts dependencies correctly (filters out "none")', () => {
        const specs = parseTaskSpecs(WELL_FORMED_OUTPUT);
        const second = specs[1];

        expect(second.dependencies).toEqual([
            'Create User interface in src/types/user.ts',
        ]);
    });

    it('extracts list items via parseTaskSpecs (covers extractListItems)', () => {
        const specs = parseTaskSpecs(WELL_FORMED_OUTPUT);
        // Second task has 2 files
        expect(specs[1].files).toEqual([
            'src/auth/password.ts',
            'tests/auth/password.test.ts',
        ]);
    });

    it('uses defaults for missing fields', () => {
        const minimal = `
--- TASK ---
TITLE: Do something
TYPE: fix-bug
ESTIMATED_MINUTES: 2
ENTRY_CONDITIONS:
EXIT_CRITERIA:
FILES:
DEPENDS_ON:
DESCRIPTION: A task.
--- END TASK ---
`;
        const specs = parseTaskSpecs(minimal);
        expect(specs).toHaveLength(1);
        expect(specs[0].entryConditions).toEqual([]);
        expect(specs[0].exitCriteria).toEqual([]);
        expect(specs[0].files).toEqual([]);
        expect(specs[0].dependencies).toEqual([]);
    });
});

describe('validateTaskSpecs', () => {
    const validSpec: TaskSpec = {
        title: 'Create User interface in src/types/user.ts',
        description: 'Define the User interface.',
        estimatedMinutes: 3,
        entryConditions: ['src/types/ directory exists'],
        exitCriteria: ['User interface exported', 'tsc passes'],
        files: ['src/types/user.ts'],
        dependencies: [],
        taskType: 'implement',
    };

    it('returns no warnings for valid specs', () => {
        expect(validateTaskSpecs([validSpec])).toEqual([]);
    });

    it('warns on short titles', () => {
        const short = { ...validSpec, title: 'Fix' };
        const warnings = validateTaskSpecs([short]);
        expect(warnings).toEqual(
            expect.arrayContaining([expect.stringContaining('title too vague')])
        );
    });

    it('warns on missing exit criteria', () => {
        const noExit = { ...validSpec, exitCriteria: [] };
        const warnings = validateTaskSpecs([noExit]);
        expect(warnings).toEqual(
            expect.arrayContaining([expect.stringContaining('missing exit criteria')])
        );
    });

    it('warns on out-of-range estimates', () => {
        const tooLong = { ...validSpec, estimatedMinutes: 20 };
        const warnings = validateTaskSpecs([tooLong]);
        expect(warnings).toEqual(
            expect.arrayContaining([expect.stringContaining('outside 2-5min range')])
        );
    });

    it('warns on missing dependency references', () => {
        const badDep = { ...validSpec, dependencies: ['Nonexistent task'] };
        const warnings = validateTaskSpecs([badDep]);
        expect(warnings).toEqual(
            expect.arrayContaining([expect.stringContaining('dependency "Nonexistent task" not found')])
        );
    });

    it('warns on no files specified', () => {
        const noFiles = { ...validSpec, files: [] };
        const warnings = validateTaskSpecs([noFiles]);
        expect(warnings).toEqual(
            expect.arrayContaining([expect.stringContaining('no files specified')])
        );
    });
});
