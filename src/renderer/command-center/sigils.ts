/**
 * sigils.ts — Autonaut sigil glyphs (inline SVG).
 *
 * One geometric sigil per agent. SVGs use `currentColor` for both stroke
 * and fill so the consumer themes them via CSS `color` (typically a
 * `--agent-*` token on the parent).
 *
 * Usage:
 *   element.innerHTML = getSigilHtml('forge', { className: 'agent-sigil', size: 32 });
 *
 *   // For SVG-context embedding (inside an existing <svg>), use the
 *   // inner-paths form which omits the wrapping <svg> element:
 *   svgGroup.innerHTML = SIGIL_INNER.forge;
 *
 * Source: docs/design_pack/wave-2-mission-control/design-system/assets/sigils/
 */

export type AutonautId =
    | 'sensei'
    | 'scout'
    | 'blueprint'
    | 'pixel'
    | 'forge'
    | 'cipher'
    | 'aegis'
    | 'vigil'
    | 'herald';

/**
 * Inner SVG markup for each sigil — the path/shape elements only,
 * with no wrapping `<svg>`. Suitable for splicing into an existing SVG
 * context (e.g. orchestration graph nodes).
 */
export const SIGIL_INNER: Readonly<Record<AutonautId, string>> = Object.freeze({
    sensei:
        '<circle cx="12" cy="12" r="8"></circle>' +
        '<circle cx="12" cy="12" r="4"></circle>' +
        '<circle cx="12" cy="12" r="1" fill="currentColor"></circle>',
    scout:
        '<circle cx="12" cy="12" r="8.25"></circle>' +
        '<path d="M12 4.5 V6"></path>' +
        '<path d="M12 18 V19.5"></path>' +
        '<path d="M4.5 12 H6"></path>' +
        '<path d="M18 12 H19.5"></path>' +
        '<path d="M12 12 L15.5 9"></path>',
    blueprint:
        '<rect x="4" y="4" width="16" height="16" rx="0.5"></rect>' +
        '<path d="M9.333 4 V20"></path>' +
        '<path d="M14.667 4 V20"></path>' +
        '<path d="M4 9.333 H20"></path>' +
        '<path d="M4 14.667 H20"></path>',
    pixel:
        '<rect x="4.5" y="4.5" width="15" height="15" rx="0.5" fill="currentColor"></rect>',
    forge:
        '<path d="M12 4 L20.5 19 L3.5 19 Z" fill="currentColor"></path>',
    cipher:
        '<path d="M5 5 L19 19"></path>' +
        '<path d="M19 5 L5 19"></path>' +
        '<circle cx="12" cy="12" r="2" fill="currentColor"></circle>',
    aegis:
        '<path d="M12 4 L19.5 6.5 L19.5 12 C19.5 16 16.25 19 12 20 C7.75 19 4.5 16 4.5 12 L4.5 6.5 Z"></path>',
    vigil:
        '<path d="M2.5 12 C5.5 7.5 8.5 5.5 12 5.5 C15.5 5.5 18.5 7.5 21.5 12 C18.5 16.5 15.5 18.5 12 18.5 C8.5 18.5 5.5 16.5 2.5 12 Z"></path>' +
        '<circle cx="12" cy="12" r="3.5"></circle>' +
        '<circle cx="12" cy="12" r="1" fill="currentColor"></circle>',
    herald:
        '<path d="M6 3 V21"></path>' +
        '<path d="M6 4.5 L18 7.5 L6 13.5 Z"></path>',
});

/**
 * Lowercase set of valid Autonaut IDs — used to narrow string inputs
 * coming from agent names ("Forge" → "forge").
 */
const VALID_IDS: ReadonlySet<string> = new Set(Object.keys(SIGIL_INNER));

export function isAutonautId(id: string): id is AutonautId {
    return VALID_IDS.has(id);
}

/**
 * Coerce an arbitrary agent name/id string into an `AutonautId`, or
 * return `null` if it is not one of the nine recognized agents.
 */
export function toAutonautId(raw: string): AutonautId | null {
    const lower = raw.toLowerCase().trim();
    return isAutonautId(lower) ? lower : null;
}

interface GetSigilHtmlOptions {
    /** Extra class to apply to the root <svg> element. */
    readonly className?: string;
    /** Pixel size for `width` and `height` attributes. Defaults to no attrs (CSS sizes it). */
    readonly size?: number;
    /** Optional aria-label. If omitted, the SVG is marked aria-hidden. */
    readonly label?: string;
}

/**
 * Returns a complete inline `<svg>…</svg>` string for the given agent.
 *
 * Color is inherited from the parent's CSS `color` property via
 * `currentColor`, so wrap the call site with a parent that sets
 * `color: var(--agent-forge)` (or similar) to theme it.
 *
 * Falls back to a generic round dot for unknown agent IDs — never throws,
 * never returns the wrong sigil.
 */
export function getSigilHtml(agentId: string, options: GetSigilHtmlOptions = {}): string {
    const id = toAutonautId(agentId);
    const inner = id !== null
        ? SIGIL_INNER[id]
        : '<circle cx="12" cy="12" r="6" fill="currentColor"></circle>';

    const classAttr = options.className !== undefined
        ? ` class="${escapeAttr(options.className)}"`
        : '';
    const sizeAttrs = options.size !== undefined
        ? ` width="${options.size}" height="${options.size}"`
        : '';
    const a11yAttrs = options.label !== undefined
        ? ` role="img" aria-label="${escapeAttr(options.label)}"`
        : ' aria-hidden="true" focusable="false"';

    return (
        `<svg xmlns="http://www.w3.org/2000/svg"${classAttr}${sizeAttrs}` +
        ` viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
        ` stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"` +
        `${a11yAttrs}>${inner}</svg>`
    );
}

/**
 * HTML attribute escape — quotes, ampersands, brackets only.
 * Sigil call sites use it for `className` and `label` which originate
 * in code, not user input, but we sanitize anyway as defense in depth.
 */
function escapeAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
