/**
 * Deterministic mock AI responses for pipeline testing.
 *
 * Each phase produces a realistic JSON task list so we can test
 * the full orchestration pipeline without real API keys.
 */

export type Phase = 'discovery' | 'poc' | 'business-viability' | 'design-planning' | 'development' | 'launch-growth';

export interface MockTask {
    title: string;
    description: string;
    taskType: string;
    assignedAgent: string;
    priority: number;
    dependsOn: string[];
}

const PHASE_TASKS: Record<Phase, MockTask[]> = {
    discovery: [
        {
            title: 'Feasibility Assessment',
            description: 'Assess technical feasibility of the calculator CLI project.',
            taskType: 'general',
            assignedAgent: 'scout',
            priority: 9,
            dependsOn: [],
        },
        {
            title: 'Architecture Overview',
            description: 'Define high-level architecture for the calculator CLI.',
            taskType: 'architecture',
            assignedAgent: 'blueprint',
            priority: 8,
            dependsOn: [],
        },
    ],
    poc: [
        {
            title: 'Build CLI Prototype',
            description: 'Implement a minimal working prototype of the calculator CLI.',
            taskType: 'implement',
            assignedAgent: 'forge',
            priority: 9,
            dependsOn: [],
        },
    ],
    'business-viability': [
        {
            title: 'Market Analysis',
            description: 'Analyse market opportunity for calculator CLI tooling.',
            taskType: 'general',
            assignedAgent: 'scout',
            priority: 7,
            dependsOn: [],
        },
    ],
    'design-planning': [
        {
            title: 'Sprint Plan',
            description: 'Create a sprint plan for calculator CLI development.',
            taskType: 'general',
            assignedAgent: 'blueprint',
            priority: 8,
            dependsOn: [],
        },
    ],
    development: [
        {
            title: 'Implement Core Calculator',
            description: 'Implement add, subtract, multiply, divide operations.',
            taskType: 'implement',
            assignedAgent: 'forge',
            priority: 9,
            dependsOn: [],
        },
    ],
    'launch-growth': [
        {
            title: 'Deployment Script',
            description: 'Create deployment script for calculator CLI release.',
            taskType: 'implement',
            assignedAgent: 'aegis',
            priority: 7,
            dependsOn: [],
        },
    ],
};

/**
 * Returns a deterministic task list JSON string for a given phase.
 * Mimics the format that TaskDecomposer expects from the AI response.
 */
export function getMockTaskListForPhase(phase: Phase): string {
    const tasks = PHASE_TASKS[phase] ?? PHASE_TASKS.discovery;
    return JSON.stringify(tasks);
}

/**
 * Returns a mock agent output for a given task type.
 */
export function getMockAgentOutput(taskType: string, taskTitle: string): string {
    switch (taskType) {
        case 'architecture':
            return `# Architecture: ${taskTitle}\n\nThe system uses a layered architecture with a CLI interface, core logic module, and I/O handler.\n\n## Components\n- CLI Parser\n- Calculator Core\n- Output Formatter`;

        case 'implement':
            return `# Implementation: ${taskTitle}\n\n\`\`\`typescript\n// calculator.ts\nexport function add(a: number, b: number): number { return a + b; }\nexport function subtract(a: number, b: number): number { return a - b; }\n\`\`\`\n\n\`\`\`json\n{"path": "src/calculator.ts", "content": "// calculator implementation"}\n\`\`\``;

        case 'code-review':
            return `# Code Review\n\n**Verdict: PASS**\n\nQuality score: 8/10\n\nNo critical issues found. The implementation follows best practices.\n\n## Summary\nCode is clean and well-structured.`;

        default:
            return `# ${taskTitle}\n\nTask completed successfully. Analysis and recommendations documented.`;
    }
}

/**
 * Returns a mock review verdict (always passes for pipeline testing).
 */
export function getMockReviewVerdict(): { verdict: 'pass' | 'fail'; score: number; summary: string } {
    return {
        verdict: 'pass',
        score: 8,
        summary: 'Code review passed. No critical issues found.',
    };
}
