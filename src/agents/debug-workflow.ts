/**
 * Debug Workflow for KageOps agents.
 * 4-phase structured debugging: Investigation → Evidence Gathering → Hypothesis Testing → Fix Verification.
 * Prevents random guessing by enforcing evidence-based root cause analysis.
 */

/** Phase in the debug workflow */
export type DebugPhase = 'investigation' | 'evidence' | 'hypothesis' | 'verification';

/** All phases in order */
export const ALL_PHASES: readonly DebugPhase[] = [
    'investigation',
    'evidence',
    'hypothesis',
    'verification',
];

/** A piece of evidence collected during debugging */
export interface DebugEvidence {
    readonly type: 'error-log' | 'stack-trace' | 'reproduction' | 'test-result' | 'git-bisect' | 'observation';
    readonly description: string;
    readonly data: string;
}

/** A hypothesis about the root cause of a bug */
export interface DebugHypothesis {
    readonly id: number;
    readonly description: string;
    readonly likelihood: 'high' | 'medium' | 'low';
    readonly testPlan: string;
    readonly disproved: boolean;
}

/** Full state of a debug session */
export interface DebugState {
    readonly phase: DebugPhase;
    readonly bugDescription: string;
    readonly evidence: readonly DebugEvidence[];
    readonly hypotheses: readonly DebugHypothesis[];
    readonly rootCause: string | null;
    readonly fix: string | null;
    readonly verified: boolean;
}

/** Final result of a completed debug workflow */
export interface DebugWorkflowResult {
    readonly state: DebugState;
    readonly phasesCompleted: readonly DebugPhase[];
    readonly report: string;
}

/** Returns initial state in 'investigation' phase with empty evidence/hypotheses */
export function createInitialState(bugDescription: string): DebugState {
    return {
        phase: 'investigation',
        bugDescription,
        evidence: [],
        hypotheses: [],
        rootCause: null,
        fix: null,
        verified: false,
    };
}

/** Phase 1 prompt: investigate symptoms without attempting a fix */
export function buildInvestigationPrompt(bugDescription: string): string {
    return [
        'DEBUG PHASE 1: INVESTIGATION — Do NOT try to fix it yet.',
        '',
        'Analyze this bug systematically. Your goal is to understand the problem, not solve it.',
        '',
        `Bug: ${bugDescription}`,
        '',
        'Tasks:',
        '- Identify affected components and modules',
        '- Note all visible symptoms and error patterns',
        '- Check related code paths',
        '- Describe what is happening vs. what should happen',
        '',
        'Output structured evidence using this format:',
        'EVIDENCE: <type: error-log|stack-trace|reproduction|test-result|git-bisect|observation>',
        'DESCRIPTION: <short description of what was found>',
        'DATA: <raw content, log lines, code snippet, or observation>',
        'END EVIDENCE',
        '',
        'Output multiple EVIDENCE blocks as needed.',
        'Do NOT propose fixes. Observation only.',
    ].join('\n');
}

/** Phase 2 prompt: gather more data based on existing evidence */
export function buildEvidenceGatheringPrompt(
    bugDescription: string,
    evidence: readonly DebugEvidence[]
): string {
    const evidenceLines = evidence.map(e =>
        `[${e.type}] ${e.description}: ${e.data}`
    ).join('\n');

    return [
        'DEBUG PHASE 2: EVIDENCE GATHERING — Collect more targeted data.',
        '',
        `Bug: ${bugDescription}`,
        '',
        '## Evidence Collected So Far',
        evidenceLines || '(none)',
        '',
        'Based on the evidence above, gather additional data:',
        '- Check relevant log files for more context',
        '- Identify minimal reproduction steps',
        '- Run related tests and note results',
        '- Check git history for recent changes to affected areas',
        '- Look for similar past issues or patterns',
        '',
        'Output structured evidence using this format:',
        'EVIDENCE: <type: error-log|stack-trace|reproduction|test-result|git-bisect|observation>',
        'DESCRIPTION: <short description of what was found>',
        'DATA: <raw content, log lines, code snippet, or observation>',
        'END EVIDENCE',
        '',
        'Output multiple EVIDENCE blocks. Do NOT propose fixes yet.',
    ].join('\n');
}

/** Phase 3 prompt: form ranked hypotheses about root cause */
export function buildHypothesisPrompt(
    bugDescription: string,
    evidence: readonly DebugEvidence[]
): string {
    const evidenceLines = evidence.map(e =>
        `[${e.type}] ${e.description}: ${e.data}`
    ).join('\n');

    return [
        'DEBUG PHASE 3: HYPOTHESIS TESTING — Form and rank root cause hypotheses.',
        '',
        `Bug: ${bugDescription}`,
        '',
        '## All Evidence Collected',
        evidenceLines || '(none)',
        '',
        'Based on the evidence, form hypotheses about the root cause.',
        'Rank each by likelihood (high/medium/low) and describe how to test it.',
        '',
        'Output each hypothesis using this format:',
        'HYPOTHESIS: <description of the potential root cause>',
        'LIKELIHOOD: high|medium|low',
        'TEST: <specific steps or checks to confirm or disprove this hypothesis>',
        'END HYPOTHESIS',
        '',
        'List hypotheses from most to least likely.',
        'Be specific — vague hypotheses cannot be tested.',
    ].join('\n');
}

/** Phase 4 prompt: verify the fix is correct and complete */
export function buildVerificationPrompt(
    bugDescription: string,
    rootCause: string,
    fix: string
): string {
    return [
        'DEBUG PHASE 4: FIX VERIFICATION — Confirm the fix is correct and complete.',
        '',
        `Bug: ${bugDescription}`,
        '',
        `## Identified Root Cause`,
        rootCause,
        '',
        '## Proposed Fix',
        fix,
        '',
        'Tasks:',
        '- Write a regression test that would have caught this bug',
        '- Confirm the root cause is directly addressed by the fix',
        '- Check for side effects or regressions in related components',
        '- Verify edge cases are handled',
        '- Confirm no similar bugs exist in nearby code',
        '',
        'Output your findings with clear PASS/FAIL for each check.',
    ].join('\n');
}

/** Parses structured EVIDENCE blocks from AI output */
export function parseEvidence(aiOutput: string): readonly DebugEvidence[] {
    const validTypes = new Set<DebugEvidence['type']>([
        'error-log', 'stack-trace', 'reproduction', 'test-result', 'git-bisect', 'observation',
    ]);

    const blockPattern = /EVIDENCE:\s*([^\n]+)\nDESCRIPTION:\s*([^\n]+)\nDATA:\s*([\s\S]*?)END EVIDENCE/g;
    const results: DebugEvidence[] = [];
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(aiOutput)) !== null) {
        const rawType = match[1].trim() as DebugEvidence['type'];
        const description = match[2].trim();
        const data = match[3].trim();
        const type = validTypes.has(rawType) ? rawType : 'observation';
        results.push({ type, description, data });
    }

    return results;
}

/** Parses structured HYPOTHESIS blocks from AI output */
export function parseHypotheses(aiOutput: string): readonly DebugHypothesis[] {
    const blockPattern = /HYPOTHESIS:\s*([^\n]+)\nLIKELIHOOD:\s*([^\n]+)\nTEST:\s*([\s\S]*?)END HYPOTHESIS/g;
    const results: DebugHypothesis[] = [];
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(aiOutput)) !== null) {
        const description = match[1].trim();
        const rawLikelihood = match[2].trim().toLowerCase();
        const testPlan = match[3].trim();
        const likelihood: DebugHypothesis['likelihood'] =
            rawLikelihood === 'high' || rawLikelihood === 'medium' || rawLikelihood === 'low'
                ? rawLikelihood
                : 'low';
        results.push({
            id: results.length + 1,
            description,
            likelihood,
            testPlan,
            disproved: false,
        });
    }

    return results;
}

/** Immutably advances state to next phase, merging new evidence/hypotheses */
export function advancePhase(
    state: DebugState,
    newEvidence?: readonly DebugEvidence[],
    newHypotheses?: readonly DebugHypothesis[],
    rootCause?: string,
    fix?: string
): DebugState {
    const currentIndex = ALL_PHASES.indexOf(state.phase);
    const nextPhase = ALL_PHASES[currentIndex + 1] ?? state.phase;

    return {
        ...state,
        phase: nextPhase,
        evidence: newEvidence !== undefined
            ? [...state.evidence, ...newEvidence]
            : state.evidence,
        hypotheses: newHypotheses !== undefined
            ? [...state.hypotheses, ...newHypotheses]
            : state.hypotheses,
        rootCause: rootCause !== undefined ? rootCause : state.rootCause,
        fix: fix !== undefined ? fix : state.fix,
    };
}

/** Generates a markdown debug report with all phases, evidence, hypotheses, and outcome */
export function formatDebugReport(state: DebugState): string {
    const lines: string[] = [
        '# Debug Report',
        '',
        `**Bug:** ${state.bugDescription}`,
        `**Phase:** ${state.phase}`,
        `**Verified:** ${state.verified ? 'Yes' : 'No'}`,
        '',
        '---',
        '',
        '## Phase 1 — Investigation',
        '',
        state.evidence.length > 0
            ? '### Evidence Collected'
            : '_No evidence collected yet._',
    ];

    for (const ev of state.evidence) {
        lines.push(`- **[${ev.type}]** ${ev.description}`);
        if (ev.data) {
            lines.push(`  \`\`\`\n  ${ev.data}\n  \`\`\``);
        }
    }

    lines.push('', '---', '', '## Phase 2 — Evidence Gathering', '');
    lines.push(state.evidence.length > 0
        ? `${state.evidence.length} evidence item(s) collected across phases 1–2.`
        : '_No additional evidence gathered._');

    lines.push('', '---', '', '## Phase 3 — Hypotheses', '');

    if (state.hypotheses.length === 0) {
        lines.push('_No hypotheses formed yet._');
    } else {
        for (const h of state.hypotheses) {
            lines.push(`### Hypothesis ${h.id}: ${h.description}`);
            lines.push(`- **Likelihood:** ${h.likelihood}`);
            lines.push(`- **Test Plan:** ${h.testPlan}`);
            lines.push(`- **Disproved:** ${h.disproved ? 'Yes' : 'No'}`);
            lines.push('');
        }
    }

    lines.push('---', '', '## Phase 4 — Verification', '');

    if (state.rootCause !== null) {
        lines.push(`**Root Cause:** ${state.rootCause}`, '');
    } else {
        lines.push('_Root cause not yet identified._', '');
    }

    if (state.fix !== null) {
        lines.push(`**Fix Applied:** ${state.fix}`, '');
    } else {
        lines.push('_No fix applied yet._', '');
    }

    lines.push(`**Verification Status:** ${state.verified ? 'PASSED' : 'PENDING'}`);

    return lines.join('\n');
}
