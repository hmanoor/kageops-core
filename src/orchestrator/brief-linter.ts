/**
 * Brief Quality Linter (F-361)
 *
 * Pre-run check that flags low-fidelity project briefs before any AI spend.
 *
 * Evidence from the 2026-05-14 8-arm SMB-apps benchmark: prose specs without
 * explicit required-IDs landed scores in the 88-93 range with 0% spec-coverage
 * signal — because parseSpec couldn't extract any required-IDs. Landing-page
 * specs that DO list `<section id="…">` explicitly hit 94-95 with measurable
 * coverage. Same model, same Forge prompt — only the brief quality differed.
 *
 * This module produces a structured set of warnings the New Project UI (and
 * the headless runner's dry-run preview) can show with a "fix it / proceed
 * anyway" choice. No hard block — operators may legitimately want to ship
 * a vague brief and rely on Sensei's interpretation.
 */

export type BriefLintKind =
    | 'no-required-ids'
    | 'no-measurable-criteria'
    | 'no-tech-stack-hint'
    | 'very-short';

export interface BriefLintWarning {
    readonly kind: BriefLintKind;
    readonly severity: 'info' | 'warn';
    readonly message: string;
    readonly suggestion: string;
}

export interface BriefLintResult {
    readonly briefLength: number;
    readonly warnings: readonly BriefLintWarning[];
    /**
     * True when the brief has at least one explicit required-ID reference
     * AND at least one measurable acceptance criterion ("must contain",
     * "should display", numeric requirement, etc.). These are the briefs
     * the auto-rubric can actually score.
     */
    readonly scoreable: boolean;
}

const MIN_BRIEF_LENGTH = 80;
// Match either `id="X"`/`id='X'` (word boundary before "id") OR `#X` (no
// word-boundary anchor — # is non-word so \b doesn't help with preceding
// whitespace). Both forms are common in well-written briefs.
const ID_REGEX = /(?:\bid\s*=\s*["']([a-z][\w-]*)["']|#([a-z][\w-]*))/gi;
const MEASURABLE_REGEX = /\b(must|should|required|will|displays?|shows?|exactly|at least|no more than|cannot)\b/i;
const TECH_HINT_REGEX = /\b(html|css|javascript|typescript|react|vue|svelte|next|node|express|python|django|flask|postgres|sqlite|localstorage|fastapi)\b/i;

export function lintBrief(briefText: string): BriefLintResult {
    const length = briefText.length;
    const warnings: BriefLintWarning[] = [];

    if (length < MIN_BRIEF_LENGTH) {
        warnings.push({
            kind: 'very-short',
            severity: 'warn',
            message: `Brief is only ${length} characters — Sensei will have to invent most of the project.`,
            suggestion: 'Add at least one concrete feature description and one acceptance criterion.',
        });
    }

    const idMatches = Array.from(briefText.matchAll(ID_REGEX));
    const hasRequiredIds = idMatches.length > 0;
    if (!hasRequiredIds) {
        warnings.push({
            kind: 'no-required-ids',
            severity: 'info',
            message: 'Brief does not list any required HTML IDs (e.g. `#student-list`, `id="theme-toggle"`).',
            suggestion: 'The acceptance gate scores against required-IDs. Adding `#example-id` or `id="example-id"` mentions to the brief lets Forge target exact elements and gives the auto-rubric a real coverage signal.',
        });
    }

    const hasMeasurable = MEASURABLE_REGEX.test(briefText);
    if (!hasMeasurable) {
        warnings.push({
            kind: 'no-measurable-criteria',
            severity: 'info',
            message: 'Brief uses no measurable criteria ("must", "should", "displays", etc.) — Vigil has nothing to verify.',
            suggestion: 'Reword at least one feature as "must show X" / "should display Y" / "exactly N rows" so Vigil can confirm Forge actually shipped it.',
        });
    }

    const hasTechHint = TECH_HINT_REGEX.test(briefText);
    if (!hasTechHint) {
        warnings.push({
            kind: 'no-tech-stack-hint',
            severity: 'info',
            message: 'Brief does not mention a tech stack (HTML, JS, React, etc.).',
            suggestion: 'Even one line ("vanilla HTML + CSS + JS, no build step") prevents Forge from speculating on a heavier framework than you want.',
        });
    }

    return {
        briefLength: length,
        warnings,
        scoreable: hasRequiredIds && hasMeasurable,
    };
}
