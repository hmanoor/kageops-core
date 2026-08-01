/**
 * The load-bearing assumption behind a phase's work.
 *
 * Why this exists: the guardrails we had catch the wrong failure. A budget cap
 * catches a runaway loop. The acceptance gate catches an artifact that misses a
 * stated requirement. Neither catches the expensive one — hours of confident,
 * internally-correct work built on a false premise, where every individual step
 * looks reasonable under review.
 *
 * We already pause at every phase boundary, including the two expensive ones
 * (architecture, deploy). But the approval card said "Business Viability —
 * awaiting your review" with an Approve button: it gated on the *phase*, not on
 * the *reasoning*. The checkpoint existed and had nothing falsifiable in it.
 *
 * So a gate now carries a claim the operator can disagree with. "This assumes
 * the client wants server-side rendering" is something a human can reject in two
 * seconds. "Business Viability — awaiting your review" is not.
 *
 * Credit: raised by KimLikeJ on r/AgentsOfAI, who pointed out that a hard cost
 * limit does nothing for a silent wrong turn, and that making the agent state
 * its assumption before the expensive step is cheap and catches it early.
 */

/** How confident the agent is that the assumption holds. */
export type AssumptionConfidence = 'high' | 'medium' | 'low';

export interface PhaseAssumption {
    /** The single load-bearing claim, phrased so a human can disagree with it. */
    readonly claim: string;
    /** What becomes wrong if the claim is false — the cost of not catching it. */
    readonly ifWrong: string;
    readonly confidence: AssumptionConfidence;
    /** Phase whose work rests on this claim. */
    readonly phase: string;
    /** Where it came from — the brief, a prior decision, or the agent's inference. */
    readonly basis: 'brief' | 'prior-decision' | 'inferred';
}

/**
 * The question we put to the agent. Deliberately targeted rather than open:
 * "state your assumptions" reliably produces a paragraph of hedging, while a
 * question with a forced shape produces something falsifiable.
 *
 * Kept as a single exported constant so the wording is reviewable in one place
 * — it is the whole mechanism.
 */
export function buildAssumptionPrompt(phase: string, workSummary: string): string {
    return [
        `You have just completed the "${phase}" phase. Before a human decides`,
        'whether to let the next phase run, state the single assumption that most',
        'of this work rests on.',
        '',
        'Rules:',
        '- ONE assumption, the load-bearing one. Not a list.',
        '- Phrase it so a human could disagree with it in one sentence.',
        '- If it is wrong, most of the following work is wasted. If your candidate',
        '  assumption being wrong would cost nothing, it is the wrong one to state.',
        '- Do not hedge. "The user probably wants something good" is useless.',
        '',
        'Work completed:',
        workSummary,
        '',
        'Respond in exactly this format, nothing else:',
        'CLAIM: <the assumption, one sentence>',
        'IF_WRONG: <what becomes wasted work, one sentence>',
        'CONFIDENCE: high | medium | low',
        'BASIS: brief | prior-decision | inferred',
    ].join('\n');
}

const CONFIDENCES: readonly AssumptionConfidence[] = ['high', 'medium', 'low'];
const BASES: readonly PhaseAssumption['basis'][] = ['brief', 'prior-decision', 'inferred'];

/**
 * Parse the agent's response. Returns null rather than a half-filled object
 * when the model ignored the format — a malformed assumption is worse than
 * none, because a gate showing a garbled claim trains the operator to click
 * through without reading.
 */
export function parseAssumption(response: string, phase: string): PhaseAssumption | null {
    const field = (name: string): string => {
        const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(response);
        return m?.[1]?.trim() ?? '';
    };

    const claim = field('CLAIM');
    const ifWrong = field('IF_WRONG');
    if (claim === '' || ifWrong === '') return null;

    const rawConfidence = field('CONFIDENCE').toLowerCase();
    const rawBasis = field('BASIS').toLowerCase();

    const confidence = CONFIDENCES.find((c) => rawConfidence.startsWith(c)) ?? 'medium';
    const basis = BASES.find((b) => rawBasis.startsWith(b)) ?? 'inferred';

    return { claim, ifWrong, confidence, phase, basis };
}

/**
 * One-line rendering for the approval card. Leads with the claim, because the
 * claim is the thing being approved.
 */
export function formatAssumptionForHuman(a: PhaseAssumption): string {
    return `Assumes: ${a.claim} — if wrong, ${a.ifWrong} (confidence: ${a.confidence}, from: ${a.basis})`;
}

/**
 * True when an assumption deserves the operator's attention even if they would
 * otherwise auto-approve: low confidence, or a guess the agent made up rather
 * than read from the brief. These are the ones that turn into five wasted hours.
 */
export function warrantsReview(a: PhaseAssumption): boolean {
    return a.confidence === 'low' || (a.basis === 'inferred' && a.confidence !== 'high');
}

/**
 * Whether to spend one short AI call per phase gate eliciting the assumption.
 *
 * On by default — the whole point is catching a wrong premise before hours of
 * work rest on it, and a run has roughly six gates, so the cost is a rounding
 * error next to the work it protects. Disable with KAGEOPS_ASSUMPTION_GATES=0
 * for benchmark runs, or where every token is being counted.
 */
export function assumptionGatesEnabled(): boolean {
    const raw = (process.env['KAGEOPS_ASSUMPTION_GATES'] ?? '').trim().toLowerCase();
    if (raw === '') return true;
    return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}
