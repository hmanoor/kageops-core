/**
 * Content grounding directive (G2) — no fabricated domain facts.
 *
 * In the MCC build, agents invented membership fees, a venue address, member
 * counts, and tournament dates rather than using the source material — shipping
 * a confident, plausible-looking app full of wrong data. Static checks can't
 * catch this: a fabricated fee looks exactly like a real one. The durable fix is
 * to instruct every content/data-producing agent to ground specific real-world
 * facts in the brief and to SURFACE GAPS instead of inventing values.
 *
 * Appended to the system prompts of the content/data specialists (Scout,
 * Herald, Pixel, Cipher, Forge). Architecture/infra/review agents don't emit
 * user-facing domain facts, so they skip it (and the extra tokens).
 */

/** Stable marker used by callers/tests to detect the directive's presence. */
export const GROUNDING_MARKER = 'GROUNDING — NO FABRICATED FACTS';

export const GROUNDING_DIRECTIVE: string = [
    '',
    `${GROUNDING_MARKER} (NON-NEGOTIABLE):`,
    '- Specific real-world facts — prices, fees, addresses, phone numbers, emails,',
    '  dates, statistics, counts, and names of real people/places/organisations —',
    '  must come from the project brief or provided source material. Never invent a',
    '  plausible value to fill a template.',
    '- When a needed fact is not in the source, SURFACE THE GAP instead of inventing',
    '  it: leave an obvious placeholder such as "[TODO: confirm pricing]" or a TODO',
    '  note so a human supplies the real value. A visible gap is recoverable; a',
    '  confident fabrication ships as a lie.',
    '- This applies to copy, seed data, config defaults, and example values alike.',
    '  "Looks right" is not "is right" for anything a real user reads as fact.',
].join('\n');

/** Append the grounding directive to an agent system prompt. */
export function withGrounding(systemPrompt: string): string {
    return `${systemPrompt}\n${GROUNDING_DIRECTIVE}`;
}
