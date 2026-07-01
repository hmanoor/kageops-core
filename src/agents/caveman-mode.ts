/**
 * Caveman Mode — Terse inter-agent communication rules.
 *
 * Injected into agent-to-agent system prompts to reduce output tokens ~65%.
 * Human-facing output (Sensei chat) stays in normal verbose mode.
 */

// ── Caveman Rules ───────────────────────────────────

export const CAVEMAN_AGENT_RULES = `
## CAVEMAN MODE (agent-to-agent comms)

You are communicating with another AI agent, not a human.
Be maximally terse. Every saved token counts.

Rules:
- Drop articles (a, an, the)
- Drop filler ("Sure!", "I'd be happy to", "Great question", "basically", "essentially")
- Fragments OK — no need for complete sentences
- Short synonyms preferred (use -> err, fix -> patch, remove -> rm, function -> fn)
- No pleasantries, greetings, or sign-offs
- No markdown headers unless structuring a list
- Keep ALL technical substance: exact error messages, code, file paths, commands, line numbers
- Format: [thing] [action] [reason]. [next step].

Examples:
  BAD:  "Sure! I'd be happy to help. The function \`processData\` on line 42 has a bug where it doesn't handle null values correctly. I think we should add a null check."
  GOOD: "processData L42: missing null guard. Add \`if (data == null) return [];\` before loop."
` as const;

// ── Review Format ───────────────────────────────────

export const CAVEMAN_REVIEW_FORMAT = `
## Review Output Format

Use this format for all review findings:
L<line>: <severity_emoji> <category>: <problem>. <fix>.

Severity emojis:
  RED   bug/critical
  YLW   risk/warning
  BLU   nit
  QST   question

Example:
  L42: RED null-safety: processData crashes on undefined input. Add early return guard.
  L88: YLW perf: O(n^2) nested loop over tasks array. Switch to Map lookup.
  L15: BLU naming: var \`x\` unclear. Rename to \`retryCount\`.
` as const;

// ── Prompt Builder ──────────────────────────────────

/**
 * Wraps a base system prompt with caveman communication rules
 * when the caller is not human-facing.
 *
 * Human-facing agents (e.g. Sensei chat) get the base prompt unchanged.
 */
export function buildAgentSystemPrompt(
    basePrompt: string,
    isHumanFacing: boolean
): string {
    if (isHumanFacing) {
        return basePrompt;
    }
    return `${basePrompt}\n\n${CAVEMAN_AGENT_RULES}`;
}
