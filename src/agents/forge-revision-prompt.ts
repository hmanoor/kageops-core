/**
 * P1-07 — pure revision-prompt helpers, extracted from Forge so:
 *   1. Token-budget guard logic can be tested in isolation.
 *   2. The benchmark script (`scripts/benchmark/revision-token-cost.ts`)
 *      can use the exact same prompt the production agent uses,
 *      keeping the < 30% token cost criterion measurable against
 *      what actually ships.
 *
 * `buildRevisionPrompt` returns the prompt string + diagnostics:
 *   - `estimatedTokens` so callers can log or short-circuit.
 *   - `truncatedFiles[]` so callers know which files got their content
 *     clipped to fit the budget.
 *
 * The budget guard is soft — it never refuses to build the prompt
 * (operators can intentionally send huge prompts on big-context
 * models). It DOES proactively truncate per-file content when the
 * total would exceed the budget, picking smaller files first so the
 * larger files keep more of their tail.
 *
 * Composes with the P1-06b Forge handler that calls this and with
 * the P1-06a Sensei stamping that supplies the `revisionInstruction`.
 */

// ── Token budget ─────────────────────────────────────

/**
 * P1-07 budget. ~8k tokens leaves headroom under Haiku's 10k guard
 * (in autonaut-agent's HAIKU-GUARD: rejecting prompt > 10k tokens)
 * while still being generous enough for a typical single-page-tool
 * revision (1-3 small files in `target_files`).
 *
 * On a model with a bigger context, the guard's "soft" — we warn +
 * truncate rather than refuse. Callers can pass `budgetTokens:
 * Infinity` to disable.
 */
export const REVISION_PROMPT_TOKEN_BUDGET = 8_000;

/** Char-to-token heuristic for English + code (4 chars/token avg). */
export const CHARS_PER_TOKEN = 4;

// ── Public API ───────────────────────────────────────

export interface RevisionFile {
    readonly path: string;
    readonly content: string;
}

export interface BuildRevisionPromptOptions {
    /** Override the default budget; pass Infinity to disable truncation. */
    readonly budgetTokens?: number;
    /** Override the char/token heuristic for non-English projects. */
    readonly charsPerToken?: number;
}

export interface BuildRevisionPromptResult {
    readonly prompt: string;
    readonly estimatedTokens: number;
    /** Files that had their content truncated to fit the budget. */
    readonly truncatedFiles: readonly string[];
    /** True when the unfiltered prompt would have exceeded the budget. */
    readonly hitBudget: boolean;
}

/**
 * P1-07: build the revision prompt with a soft token budget. Operators
 * see exactly the same prompt shape the production Forge handler uses
 * (the benchmark script reuses this for like-for-like cost comparison).
 *
 * Rule semantics (the LLM contract):
 *   1. Modify ONLY what the instruction requires; preserve everything else.
 *   2. Emit the FULL UPDATED FILE for each file you change.
 *   3. For files you do NOT change, OMIT the block entirely.
 *   4. Do not regenerate from scratch.
 *   5. Output ONLY the file blocks. Optional one-line summary at the end.
 *   6. (P1-07) End with `MODIFIED-FILES: a.html, b.css` (or `none`) so
 *      the parser can sanity-check which files actually changed without
 *      diffing every block against disk.
 */
export function buildRevisionPrompt(
    instruction: string,
    files: readonly RevisionFile[],
    options: BuildRevisionPromptOptions = {},
): BuildRevisionPromptResult {
    const budget = options.budgetTokens ?? REVISION_PROMPT_TOKEN_BUDGET;
    const charsPerToken = options.charsPerToken ?? CHARS_PER_TOKEN;

    const truncatedFiles: string[] = [];

    // Fixed prompt scaffold — instruction + rules + file list. Roughly
    // bounded by `instruction.length + (~800 chars of scaffold) +
    // file_list_length`.
    const fileListText = files.length > 0
        ? files.map((f) => `  - ${f.path}`).join('\n')
        : '  (none — write new files as needed)';
    const scaffold = buildScaffold(instruction, fileListText);
    const scaffoldTokens = Math.ceil(scaffold.length / charsPerToken);

    // Reserve scaffold tokens; remaining budget is for file contents.
    const filesBudget = Math.max(0, budget - scaffoldTokens);
    const filesBudgetChars = filesBudget * charsPerToken;

    // Per-file content tokens — start by allotting equally, then
    // grow toward each file's actual length (so small files don't
    // hog budget while large files get clipped). One sweep: pick the
    // smallest files first up to half the budget; remainder is split
    // evenly across the rest. Caps each at the file's actual length.
    const perFile = computeFileSliceBudgets(files, filesBudgetChars);

    let totalFileChars = 0;
    const sections = files.map((f, i) => {
        const sliceLen = perFile[i];
        const content = f.content.length > sliceLen
            ? f.content.slice(0, sliceLen) + `\n\n[...truncated — file was ${f.content.length} bytes; budget allowed ${sliceLen}...]`
            : f.content;
        if (f.content.length > sliceLen) truncatedFiles.push(f.path);
        totalFileChars += content.length;
        return `--- FILE: ${f.path} ---\n${content}\n--- END FILE ---`;
    });
    const filesContext = files.length > 0
        ? sections.join('\n\n')
        : '(no existing files found — fresh write OK)';

    // Slot the files context into the prompt's existing placeholder.
    const prompt = scaffold.replace('{{FILES_CONTEXT}}', filesContext);

    const estimatedTokens = Math.ceil(prompt.length / charsPerToken);
    const hitBudget = estimatedTokens > budget || truncatedFiles.length > 0;

    return { prompt, estimatedTokens, truncatedFiles, hitBudget };
}

/**
 * Estimate tokens for the from-scratch generation of one file. Used
 * by the benchmark to compute the comparison baseline. The same
 * char/token heuristic keeps the ratio honest.
 */
export function estimateFromScratchPromptTokens(
    spec: string,
    options: { readonly charsPerToken?: number } = {},
): number {
    const charsPerToken = options.charsPerToken ?? CHARS_PER_TOKEN;
    // Production from-scratch prompts include a system-prompt scaffold
    // (~1500 chars on average across the Forge specialists), the spec,
    // and example-fence preambles. Approximate at scaffold + 1.4x spec
    // length (the LLM has to think + plan, but token cost is dominated
    // by the spec the operator typed).
    const FROM_SCRATCH_SCAFFOLD_CHARS = 1500;
    return Math.ceil((FROM_SCRATCH_SCAFFOLD_CHARS + spec.length * 1.4) / charsPerToken);
}

// ── Internals ────────────────────────────────────────

function buildScaffold(instruction: string, fileListText: string): string {
    return [
        'REVISION TASK — modify the existing workspace to satisfy a single operator instruction.',
        '',
        'Operator instruction:',
        `> ${instruction}`,
        '',
        'Files currently in the workspace (you may modify any subset):',
        fileListText,
        '',
        'Rules:',
        '1. Modify ONLY what the instruction requires. Preserve every other line, attribute, class name, and structure exactly.',
        '2. Emit the FULL UPDATED FILE for each file you change. Use --- FILE: <path> --- ... --- END FILE --- blocks.',
        '3. For files you do NOT change, OMIT the block entirely (do not emit empty files).',
        '4. Do not regenerate from scratch. Do not add unrelated improvements. Do not delete content that isn\'t referenced by the instruction.',
        '5. Output ONLY the file blocks. An optional one-line summary may follow.',
        '6. End with a single line `MODIFIED-FILES: a, b, c` listing the file paths you changed (or `MODIFIED-FILES: none` if no change is needed).',
        '',
        'Current file contents:',
        '{{FILES_CONTEXT}}',
    ].join('\n');
}

/**
 * Allocate per-file content character budgets. Two-pass:
 *   1. Sort files by actual length asc. Allot each their actual
 *      length, up to (avg = remaining_budget / remaining_files).
 *      Small files don't waste budget; the surplus rolls forward.
 *   2. Remaining files split the residual evenly.
 *
 * Returns slice lengths in the ORIGINAL `files` order so the caller
 * can map back to its content array.
 */
function computeFileSliceBudgets(files: readonly RevisionFile[], totalBudget: number): readonly number[] {
    if (files.length === 0) return [];
    // Infinity = caller opted out of truncation: each file gets its
    // full length. Non-positive or NaN = degenerate input → zero
    // budget per file (the prompt becomes scaffold-only).
    if (totalBudget === Number.POSITIVE_INFINITY) return files.map((f) => f.content.length);
    if (!Number.isFinite(totalBudget) || totalBudget <= 0) return files.map(() => 0);

    // Index → length, sorted by length asc.
    const byLength = files.map((f, i) => ({ i, len: f.content.length }))
        .sort((a, b) => a.len - b.len);

    const slices = new Array<number>(files.length).fill(0);
    let remaining = totalBudget;
    let unallocated = byLength.length;

    for (const { i, len } of byLength) {
        if (unallocated === 0) break;
        const fairShare = Math.floor(remaining / unallocated);
        const give = Math.min(len, fairShare);
        slices[i] = give;
        remaining -= give;
        unallocated -= 1;
    }

    return slices;
}
