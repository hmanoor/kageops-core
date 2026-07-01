/**
 * TDD Workflow Enforcement for Forge agent.
 * RED → GREEN → IMPROVE cycle with verification at each step.
 * Inspired by: Superpowers test-driven-development skill.
 */

/** TDD phase in the RED-GREEN-IMPROVE cycle */
export type TddPhase = 'red' | 'green' | 'improve';

/** Build the prompt for the RED phase: write failing tests first */
export function buildRedPrompt(taskTitle: string, taskDescription: string): string {
    return [
        'TDD PHASE: RED — Write failing tests FIRST.',
        '',
        'You must write tests BEFORE any implementation code.',
        'These tests should define the expected behavior and FAIL because the implementation does not exist yet.',
        '',
        `Task: ${taskTitle}`,
        `Specification: ${taskDescription}`,
        '',
        'Requirements:',
        '- Write comprehensive test cases covering:',
        '  * Happy path (normal expected behavior)',
        '  * Edge cases (empty input, null, boundaries)',
        '  * Error cases (invalid input, failures)',
        '- Use vitest as the test framework',
        '- Include descriptive test names that document behavior',
        '- Do NOT write any implementation code in this phase',
        '- Tests should import from the expected module paths',
        '',
        'Tests MUST run green once the implementation lands — a red suite is a',
        'broken feature, not a finished one. Avoid the failures we have shipped:',
        '- Import modules via their configured path (e.g. ES `import` honouring',
        '  the vitest alias) — never `require("@/...")` in setup; CJS require',
        '  bypasses the alias and throws "Cannot find module". Mock with',
        '  `vi.mock(...)` and import the mocked value.',
        '- For DOM/React tests under jsdom, stub missing browser APIs in setup',
        '  (`URL.createObjectURL`, `matchMedia`, `ResizeObserver`) rather than',
        '  assuming they exist.',
        '- Assert on stable hooks (`getByRole`, `data-testid`), not over-broad',
        '  matchers like `getByText(/.../)` that match multiple nodes.',
        '',
        'Output format: For each file, use this format:',
        '--- FILE: path/to/file.test.ts ---',
        '[test file content]',
        '--- END FILE ---',
        '',
        'IMPORTANT: Only output test files. No implementation.',
    ].join('\n');
}

/** Build the prompt for the GREEN phase: minimal implementation to pass tests */
export function buildGreenPrompt(
    taskTitle: string,
    taskDescription: string,
    testCode: string
): string {
    // 2026-06 narration-leak root cause: the RED phase sometimes produced
    // no extractable test files, so `testCode` arrives empty. The old
    // prompt still said "The tests below were written first and currently
    // fail" with an EMPTY "## Existing Tests" section — the model waited
    // on input that never arrived, spiralled, and emitted its reasoning
    // as the file body (the 374-line layout.tsx leak). When there are no
    // tests to embed, drop the "below"/"currently fail" framing entirely
    // and ask for a spec-driven implementation instead.
    const hasTests = testCode.trim().length > 0;

    const header = hasTests
        ? [
            'TDD PHASE: GREEN — Write minimal implementation to pass these tests.',
            '',
            'The tests below were written first and currently fail.',
            'Write the MINIMAL implementation code to make ALL tests pass.',
            'Do NOT add features beyond what the tests require.',
        ]
        : [
            'TDD PHASE: GREEN — Write a minimal implementation for this task.',
            '',
            'No test files were available from the RED phase, so implement',
            'directly from the specification below. Write the MINIMAL code that',
            'satisfies the spec — do NOT add features beyond what it requires.',
        ];

    const testsSection = hasTests
        ? ['', '## Existing Tests (written in RED phase)', testCode]
        : [];

    return [
        ...header,
        '',
        `Task: ${taskTitle}`,
        `Specification: ${taskDescription}`,
        ...testsSection,
        '',
        'Requirements:',
        hasTests
            ? '- Implement only what is needed to pass the tests above'
            : '- Implement only what is needed to satisfy the specification above',
        '- Follow project coding standards (TypeScript strict, immutable)',
        '- Include JSDoc comments on exported functions',
        '- Do NOT modify the test files',
        '- Output ACTUAL source code, never a description or summary of the code',
        '',
        'Output format: For each file, use this format:',
        '--- FILE: path/to/file.ts ---',
        '[implementation file content]',
        '--- END FILE ---',
        '',
        'IMPORTANT: Only output implementation files. Do NOT output test files.',
    ].join('\n');
}

/** Build the prompt for the IMPROVE phase: refactor while keeping tests green */
export function buildImprovePrompt(
    taskTitle: string,
    implementationCode: string,
    testCode: string
): string {
    return [
        'TDD PHASE: IMPROVE — Refactor the implementation while keeping tests green.',
        '',
        'Review the implementation for quality improvements:',
        '- Simplify complex logic',
        '- Extract helper functions if needed',
        '- Improve naming and readability',
        '- Add missing error handling',
        '- Optimize performance if obvious wins exist',
        '- Ensure immutability patterns are used',
        '',
        `Task: ${taskTitle}`,
        '',
        '## Current Implementation',
        implementationCode,
        '',
        '## Tests (must still pass after refactoring)',
        testCode,
        '',
        'Requirements:',
        '- All existing tests must still pass',
        '- You may add NEW tests for edge cases discovered during refactoring',
        '- Do not change behavior — only improve code quality',
        '',
        'Output format: For each file (implementation + any new tests):',
        '--- FILE: path/to/file.ts ---',
        '[file content]',
        '--- END FILE ---',
    ].join('\n');
}

/** Extract test file content from AI output (files ending in .test.ts or .spec.ts) */
export function extractTestFiles(aiOutput: string): string {
    const blocks = aiOutput.match(/--- FILE: .+?\.(?:test|spec)\.\w+ ---\n([\s\S]*?)--- END FILE ---/g);
    if (blocks === null || blocks.length === 0) return '';
    return blocks.join('\n\n');
}

/** Extract implementation file content from AI output (non-test files) */
export function extractImplFiles(aiOutput: string): string {
    const blocks = aiOutput.match(/--- FILE: (?!.+?\.(?:test|spec)\.\w+).+? ---\n([\s\S]*?)--- END FILE ---/g);
    if (blocks === null || blocks.length === 0) return '';
    return blocks.join('\n\n');
}
