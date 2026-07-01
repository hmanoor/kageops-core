/**
 * KageOps Command Center — Speciality Matrix Panel
 *
 * Heatmap visualization of agent skills.
 * Agents as rows, skills as columns, color-coded cells.
 */

// ── Types ────────────────────────────────────────────

interface MatrixEntry {
    readonly agent: string;
    readonly skill: string;
    readonly score: number;
}

// ── Color Mapping ────────────────────────────────────

function scoreToColor(score: number): string {
    if (score <= 3) return '#ef4444'; // red
    if (score <= 6) return '#eab308'; // yellow
    return '#22c55e'; // green
}

function scoreToTextColor(score: number): string {
    if (score <= 3) return '#fff';
    if (score <= 6) return '#000';
    return '#000';
}

// ── Render ───────────────────────────────────────────

/**
 * Render the speciality matrix heatmap into the given container.
 */
export function renderMatrixPanel(container: HTMLElement, entries: readonly MatrixEntry[]): void {
    if (entries.length === 0) {
        container.innerHTML = '<div class="empty-state">No matrix data available</div>';
        return;
    }

    // Group by agent → { agent: { skill: score } }
    const agentMap = new Map<string, Map<string, number>>();
    const allSkills = new Set<string>();

    for (const entry of entries) {
        if (!agentMap.has(entry.agent)) {
            agentMap.set(entry.agent, new Map());
        }
        agentMap.get(entry.agent)!.set(entry.skill, Number(entry.score));
        allSkills.add(entry.skill);
    }

    const agents = [...agentMap.keys()].sort();
    const skills = [...allSkills].sort();

    // Build HTML table
    const headerCells = skills.map((s) =>
        `<th class="matrix-skill" title="${escapeHtml(s)}">${escapeHtml(abbreviate(s))}</th>`
    ).join('');

    const rows = agents.map((agent) => {
        const agentScores = agentMap.get(agent)!;
        const cells = skills.map((skill) => {
            const score = agentScores.get(skill) ?? 0;
            const bg = scoreToColor(score);
            const fg = scoreToTextColor(score);
            return `<td class="matrix-cell" style="background:${bg};color:${fg}" title="${escapeHtml(agent)} → ${escapeHtml(skill)}: ${score.toFixed(1)}">${score.toFixed(0)}</td>`;
        }).join('');

        return `<tr><td class="matrix-agent">${escapeHtml(agent)}</td>${cells}</tr>`;
    }).join('');

    container.innerHTML = `
        <div class="matrix-wrapper">
            <table class="matrix-table">
                <thead><tr><th></th>${headerCells}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// ── Utilities ────────────────────────────────────────

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function abbreviate(skill: string): string {
    // Abbreviate long skill names for column headers
    if (skill.length <= 8) return skill;
    return skill.split('-').map((w) => w[0]?.toUpperCase() ?? '').join('');
}
