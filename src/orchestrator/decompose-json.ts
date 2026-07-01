/**
 * Robust JSON task-array recovery for weak/OSS decomposition output (BPF-36).
 *
 * The decomposer asks the model for a bare JSON array of task objects. Premium
 * models comply; weak/OSS models routinely don't — and the existing extractor
 * (`response.match(/\[[\s\S]*\]/)` + a trailing-comma repair, BPF-10) is too
 * blunt for the two failure modes that dominate the ~50% dud rate seen across
 * the ClubHubOSS dogfood runs:
 *
 *   1. PROSE WITH STRAY BRACKETS. The greedy regex matches from the FIRST `[`
 *      anywhere in the response to the LAST `]` anywhere. A preamble like
 *      "Here are the tasks [see below]:" or a trailing "[end]" makes the
 *      captured span span past the real array and fail to parse — even though a
 *      clean array sits in the middle.
 *   2. ONE BAD OBJECT IN N. The model emits 5 task objects and botches the
 *      JSON of one (a missing comma, an unquoted value). Whole-array parse
 *      throws → 0 tasks → the phase wedges, when 4 of 5 were perfectly good.
 *
 * This module recovers from both deterministically, with no model round-trip:
 *
 *   - `recoverTaskArray(response)` scans for every *balanced* top-level `[...]`
 *     span (string-aware, so brackets inside string values don't confuse it),
 *     parses each loosely (direct → conservative repair), and keeps the span
 *     yielding the most task-like objects. That defeats stray-bracket prose.
 *   - If no array span parses, it falls back to PER-OBJECT SALVAGE: scan every
 *     balanced `{...}` span, parse each independently, and keep the ones that
 *     look like a task. Four good objects survive one broken sibling.
 *
 * Repairs are intentionally conservative (trailing commas + full-line `//`
 * comments only) so we never corrupt a legitimate string value (e.g. a URL in
 * a description). Anything we can't safely repair is simply dropped, not
 * guessed at — the caller's BPF-32 reinforced re-roll and BPF-37 phase fallback
 * are the next nets.
 */

/** A task object is "task-like" if it carries any of the schema's hallmark keys. */
const TASK_KEYS = ['title', 'taskType', 'assignedAgent', 'outputPath', 'description'] as const;

/**
 * Recover an array of task-like objects from a raw LLM decomposition response.
 * Returns `null` when nothing parseable/task-like can be found (the caller then
 * re-rolls or falls back). Never throws.
 */
export function recoverTaskArray(response: string): readonly unknown[] | null {
    if (typeof response !== 'string' || response.length === 0) return null;

    // 1) Prefer a balanced top-level array. Try every candidate span and keep
    //    the one with the most task-like objects (defeats stray-bracket prose
    //    and example arrays embedded in a preamble).
    let best: readonly unknown[] | null = null;
    let bestScore = -1;
    for (const span of balancedSpans(response, '[', ']')) {
        const arr = parseArrayLoose(span);
        if (arr === null) continue;
        const score = arr.filter(isTaskish).length;
        // Prefer more task-like objects; tie-break toward the larger array so a
        // 1-element example loses to the real 5-element list.
        if (score > bestScore || (score === bestScore && best !== null && arr.length > best.length)) {
            best = arr;
            bestScore = score;
        }
    }
    if (best !== null && best.length > 0) return best;

    // 2) Per-object salvage — recover whatever individual task objects parse.
    const salvaged: unknown[] = [];
    for (const span of balancedSpans(response, '{', '}')) {
        const obj = parseObjectLoose(span);
        if (obj !== null && isTaskish(obj)) salvaged.push(obj);
    }
    return salvaged.length > 0 ? salvaged : null;
}

/**
 * Did a decomposition response genuinely fail to yield any task array (vs.
 * deliberately returning an empty `[]`)? Used to gate the reinforced re-roll
 * and the phase fallback — a valid empty array means the model chose no tasks
 * and re-asking would be wasteful.
 */
export function decompositionParseFailed(response: string): boolean {
    if (typeof response !== 'string') return true;
    // A balanced, parseable array — even an empty one — counts as "not failed".
    for (const span of balancedSpans(response, '[', ']')) {
        if (parseArrayLoose(span) !== null) return false;
    }
    // No parseable array, but salvageable objects → still recoverable, so the
    // response did "parse" in the sense that matters; not a hard failure.
    for (const span of balancedSpans(response, '{', '}')) {
        const obj = parseObjectLoose(span);
        if (obj !== null && isTaskish(obj)) return false;
    }
    return true;
}

// ── internals ────────────────────────────────────────

function isTaskish(item: unknown): boolean {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const rec = item as Record<string, unknown>;
    return TASK_KEYS.some((k) => rec[k] !== undefined);
}

function parseArrayLoose(span: string): unknown[] | null {
    const parsed = jsonLoose(span);
    return Array.isArray(parsed) ? parsed : null;
}

function parseObjectLoose(span: string): Record<string, unknown> | null {
    const parsed = jsonLoose(span);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
}

/**
 * Parse JSON, retrying once with conservative repairs (trailing commas +
 * full-line `//` comments) before giving up. Returns `undefined` on failure so
 * a legitimate `null` value is distinguishable.
 */
function jsonLoose(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        try {
            return JSON.parse(repairConservative(raw));
        } catch {
            return undefined;
        }
    }
}

/**
 * The only repairs safe to apply blind (i.e. without a full JSON tokenizer):
 *   - drop full-line `//` comments (a line whose first non-space chars are
 *     `//` — this never matches a `://` inside a URL string value, which is
 *     mid-line), and
 *   - strip trailing commas before `}` or `]` (never legal in JSON, and a
 *     comma immediately followed by a closing bracket can't occur inside a
 *     string value).
 * Both are proven low-risk; anything more aggressive (single→double quotes,
 * Python literals) risks corrupting string content and is left to the re-roll.
 */
function repairConservative(raw: string): string {
    const withoutLineComments = raw
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
    return withoutLineComments.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Return every *balanced* top-level `open`…`close` span in `text`, ignoring
 * brackets that appear inside string literals (single- or double-quoted). A
 * "top-level" span is one not nested inside another span of the same kind, so
 * `[ {…}, {…} ]` yields the single outer array, and two sibling arrays yield
 * two spans.
 */
function balancedSpans(text: string, open: string, close: string): string[] {
    const spans: string[] = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let strCh = '';
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === strCh) inStr = false;
            continue;
        }
        if (c === '"' || c === "'") {
            inStr = true;
            strCh = c;
            continue;
        }
        if (c === open) {
            if (depth === 0) start = i;
            depth++;
        } else if (c === close && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                spans.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return spans;
}
