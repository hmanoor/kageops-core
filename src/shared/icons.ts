/**
 * KageOps Icon Loader — unified Lucide-style set (viewBox 24×24, stroke
 * 1.5, currentColor). Merges the original `assets/icons/ui/` catalogue
 * with the shell-specific names introduced by the activity bar and
 * command palette. Single source of truth — renderer code imports
 * from here; do not reintroduce per-folder icon subsets.
 *
 * The SVG markup is inlined at render time. Do NOT fetch() — our CSP
 * (`img-src 'self' data:`) blocks cross-scheme URLs.
 */

export type IconName =
    | 'activity'
    | 'alert-triangle'
    | 'arrow-left'
    | 'arrow-right'
    | 'arrow-up'
    | 'bell'
    | 'book-open'
    | 'book-stack'
    | 'bot'
    | 'box'
    | 'briefcase'
    | 'check'
    | 'check-circle'
    | 'chevron-down'
    | 'chevron-left'
    | 'chevron-right'
    | 'chevron-up'
    | 'clipboard'
    | 'cloud-upload'
    | 'command'
    | 'database'
    | 'eye'
    | 'flask'
    | 'folder'
    | 'git-branch'
    | 'graph'
    | 'hammer'
    | 'help-circle'
    | 'history'
    | 'home'
    | 'hourglass'
    | 'info'
    | 'kanban'
    | 'key'
    | 'layers'
    | 'megaphone'
    | 'mic'
    | 'message-circle'
    | 'moon'
    | 'ninja'
    | 'palette'
    | 'paperclip'
    | 'pause'
    | 'play'
    | 'plus'
    | 'rocket'
    | 'rotate-ccw'
    | 'ruler'
    | 'search'
    | 'sensei'
    | 'settings'
    | 'shield'
    | 'sparkles'
    | 'spider-web'
    | 'stop'
    | 'sun'
    | 'target'
    | 'terminal'
    | 'trash'
    | 'user'
    | 'wrench'
    | 'x'
    | 'x-circle'
    | 'zap';

export interface IconOptions {
    readonly size?: number;
    readonly className?: string;
    readonly strokeWidth?: number;
    readonly ariaLabel?: string;
    readonly color?: string;
}

export const EMOJI_TO_ICON: Readonly<Record<string, IconName>> = Object.freeze({
    '📎': 'paperclip',
    '📁': 'folder',
    '📒': 'book-open',
    '📖': 'book-open',
    '📚': 'book-stack',
    '📊': 'graph',
    '📌': 'graph',
    '📋': 'clipboard',
    '🔍': 'search',
    '⚙': 'settings',
    '⚙️': 'settings',
    '▼': 'chevron-down',
    '▶': 'chevron-right',
    '▲': 'chevron-up',
    '↑': 'arrow-up',
    '→': 'arrow-right',
    '←': 'arrow-left',
    '⚠': 'alert-triangle',
    '⚠️': 'alert-triangle',
    '✅': 'check-circle',
    '❌': 'x-circle',
    '❓': 'help-circle',
    'ℹ': 'info',
    'ℹ️': 'info',
    '⏳': 'hourglass',
    '🎯': 'target',
    '🛡': 'shield',
    '🚀': 'rocket',
    '💬': 'message-circle',
    '🤖': 'bot',
    '🥷': 'ninja',
    '⚡': 'zap',
    '🌙': 'moon',
    '☀': 'sun',
    '🗑': 'trash',
    '🔑': 'key',
    '🗄': 'database',
    '🗂': 'folder',
    '🌿': 'git-branch',
    '🔧': 'wrench',
    '🧪': 'flask',
    '💼': 'briefcase',
    '👁': 'eye',
    '📣': 'megaphone',
    '📐': 'ruler',
    '🎨': 'palette',
    '⚒': 'hammer',
    '🕸': 'spider-web',
    '✨': 'sparkles',
    '🏠': 'home',
    '📦': 'box',
    '☁': 'cloud-upload',
    '☁️': 'cloud-upload',
});

const ICON_BODIES: Readonly<Record<IconName, string>> = Object.freeze({
    'activity':
        '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    'alert-triangle':
        '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
        '<path d="M12 9v4"/><path d="M12 17h.01"/>',
    'arrow-left': '<path d="M19 12H5"/><path d="m11 19-7-7 7-7"/>',
    'arrow-right': '<path d="M5 12h14"/><path d="m13 5 7 7-7 7"/>',
    'arrow-up': '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    /* Bell — Lucide-style outlined notification bell. Sits in the top
     * bar; pairs with an absolute-positioned dot/count badge to signal
     * unread items. Stroke-only so it inherits text color cleanly. */
    'bell':
        '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
        '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    'book-open':
        '<path d="M2 4.5h6a4 4 0 0 1 4 4V20a3 3 0 0 0-3-3H2z"/>' +
        '<path d="M22 4.5h-6a4 4 0 0 0-4 4V20a3 3 0 0 1 3-3h7z"/>',
    'book-stack':
        '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
        '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    'bot':
        '<path d="M12 2v3"/><rect x="4" y="7" width="16" height="12" rx="2"/>' +
        '<path d="M2 14h2"/><path d="M20 14h2"/>' +
        '<circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>' +
        '<path d="M9 17h6"/>',
    'box':
        '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' +
        '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    'briefcase':
        '<rect x="2" y="7" width="20" height="14" rx="2"/>' +
        '<path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    'check': '<path d="M20 6 9 17l-5-5"/>',
    'check-circle':
        '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'clipboard':
        '<rect x="8" y="3" width="8" height="4" rx="1"/>' +
        '<path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
    'cloud-upload':
        '<path d="M16 16l-4-4-4 4"/><path d="M12 12v9"/>' +
        '<path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>' +
        '<path d="M16 16l-4-4-4 4"/>',
    'command':
        '<path d="M15 6V3a3 3 0 1 1 3 3h-3z"/>' +
        '<path d="M9 6V3a3 3 0 1 0-3 3h3z"/>' +
        '<path d="M9 18v3a3 3 0 1 1-3-3h3z"/>' +
        '<path d="M15 18v3a3 3 0 1 0 3-3h-3z"/>' +
        '<rect x="9" y="6" width="6" height="12"/>',
    'database':
        '<ellipse cx="12" cy="5" rx="8" ry="3"/>' +
        '<path d="M4 5v14a8 3 0 0 0 16 0V5"/>' +
        '<path d="M4 12a8 3 0 0 0 16 0"/>',
    'eye':
        '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/>' +
        '<circle cx="12" cy="12" r="3"/>',
    'flask':
        '<path d="M9 2h6"/>' +
        '<path d="M10 2v6.5L4.5 18.5A2 2 0 0 0 6.3 22h11.4a2 2 0 0 0 1.8-3.5L14 8.5V2"/>' +
        '<path d="M7 14h10"/>',
    'folder':
        '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
    'git-branch':
        '<line x1="6" y1="3" x2="6" y2="15"/>' +
        '<circle cx="18" cy="6" r="3"/>' +
        '<circle cx="6" cy="18" r="3"/>' +
        '<path d="M18 9a9 9 0 0 1-9 9"/>',
    'graph':
        '<circle cx="5" cy="6" r="2.2"/><circle cx="19" cy="6" r="2.2"/>' +
        '<circle cx="12" cy="18" r="2.2"/>' +
        '<path d="M7 7.2 L10.5 16.2"/><path d="M17 7.2 L13.5 16.2"/>' +
        '<path d="M7.2 6 L16.8 6"/>',
    'hammer':
        '<path d="m15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9"/>' +
        '<path d="M17.6 6.5 20 4.1"/>' +
        '<path d="m11 6 5 5 3-3-5-5-3 3 5 5"/>',
    'help-circle':
        '<circle cx="12" cy="12" r="9"/>' +
        '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>' +
        '<path d="M12 17h.01"/>',
    'history':
        '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>' +
        '<path d="M12 7v5l3 2"/>',
    'home':
        '<path d="M3 10.5 12 3l9 7.5V20a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z"/>',
    'hourglass':
        '<path d="M6 2h12"/><path d="M6 22h12"/>' +
        '<path d="M7 2v4a5 5 0 0 0 5 5 5 5 0 0 0 5-5V2"/>' +
        '<path d="M7 22v-4a5 5 0 0 1 5-5 5 5 0 0 1 5 5v4"/>',
    'info':
        '<circle cx="12" cy="12" r="9"/>' +
        '<path d="M12 11v5"/><path d="M12 8h.01"/>',
    'kanban':
        '<rect x="3" y="3" width="5" height="14" rx="1"/>' +
        '<rect x="10" y="3" width="5" height="9" rx="1"/>' +
        '<rect x="17" y="3" width="4" height="17" rx="1"/>',
    'key':
        '<circle cx="7.5" cy="15.5" r="4.5"/>' +
        '<path d="m10.85 12.15 10.4-10.4"/>' +
        '<path d="m18 5 3 3"/><path d="m15 8 3 3"/>',
    'layers':
        '<path d="m12 2 10 5-10 5-10-5 10-5z"/>' +
        '<path d="m2 17 10 5 10-5"/>' +
        '<path d="m2 12 10 5 10-5"/>',
    'megaphone':
        '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/>' +
        '<path d="M11 6l9-3v18l-9-3"/>',
    'mic':
        '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>' +
        '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
        '<line x1="12" y1="19" x2="12" y2="22"/>',
    'message-circle':
        '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    'moon':
        '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    'ninja':
        '<path d="M4 13c0-4.4 3.6-8 8-8s8 3.6 8 8"/>' +
        '<path d="M3 13h18"/>' +
        '<path d="M3 13c0 1.5 1 3 3 3h12c2 0 3-1.5 3-3"/>' +
        '<circle cx="9" cy="14.5" r="1"/><circle cx="15" cy="14.5" r="1"/>' +
        '<path d="M12 5v-2"/>',
    'palette':
        '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/>' +
        '<circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/>' +
        '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10a1.5 1.5 0 0 0 1.5-1.5c0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.5 1.5 0 0 1 1.5-1.5H16a5 5 0 0 0 5-5c0-5-4-9-9-9z"/>',
    'paperclip':
        '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.98 8.8l-8.57 8.57a2 2 0 1 1-2.83-2.83l7.75-7.75"/>',
    'pause':
        '<rect x="6" y="4" width="4" height="16" rx="1"/>' +
        '<rect x="14" y="4" width="4" height="16" rx="1"/>',
    'play':
        '<path d="M6 4.5v15a1 1 0 0 0 1.5.87l13-7.5a1 1 0 0 0 0-1.74l-13-7.5A1 1 0 0 0 6 4.5z"/>',
    'plus':
        '<path d="M12 5v14"/><path d="M5 12h14"/>',
    'rocket':
        '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>' +
        '<path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>' +
        '<path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>' +
        '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    'rotate-ccw':
        '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    'ruler':
        '<path d="M21.3 8.7 8.7 21.3a2.4 2.4 0 0 1-3.4 0L2.7 18.7a2.4 2.4 0 0 1 0-3.4L15.3 2.7a2.4 2.4 0 0 1 3.4 0l2.6 2.6a2.4 2.4 0 0 1 0 3.4z"/>' +
        '<path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/>' +
        '<path d="m13.5 4.5 2 2"/><path d="m4.5 13.5 2 2"/>',
    'search':
        '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    /* Sensei sigil — mandala / nested concentric circles with a
     * filled center dot. Identical to docs/design_pack/wave-2-mission-control/
     * design-system/assets/sigils/sigil-sensei.svg, normalized to the
     * 24x24 icon viewBox + currentColor stroke convention. */
    'sensei':
        '<circle cx="12" cy="12" r="8"/>' +
        '<circle cx="12" cy="12" r="4"/>' +
        '<circle cx="12" cy="12" r="1" fill="currentColor"/>',
    'settings':
        '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' +
        '<circle cx="12" cy="12" r="3"/>',
    'shield':
        '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    'sparkles':
        '<path d="M12 3 14 9l6 2-6 2-2 6-2-6-6-2 6-2z"/>' +
        '<path d="M19 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/>',
    'spider-web':
        '<circle cx="12" cy="12" r="3"/>' +
        '<circle cx="12" cy="12" r="6"/>' +
        '<circle cx="12" cy="12" r="9"/>' +
        '<path d="M12 3v18"/><path d="M3 12h18"/>' +
        '<path d="m5.6 5.6 12.8 12.8"/><path d="m18.4 5.6-12.8 12.8"/>',
    'stop':
        '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    'sun':
        '<circle cx="12" cy="12" r="4"/>' +
        '<path d="M12 2v2"/><path d="M12 20v2"/>' +
        '<path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>' +
        '<path d="M2 12h2"/><path d="M20 12h2"/>' +
        '<path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    'target':
        '<circle cx="12" cy="12" r="9"/>' +
        '<circle cx="12" cy="12" r="5"/>' +
        '<circle cx="12" cy="12" r="1.5"/>',
    'terminal':
        '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
    'trash':
        '<path d="M3 6h18"/>' +
        '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
        '<path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6"/>' +
        '<path d="M10 11v6"/><path d="M14 11v6"/>',
    'user':
        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
        '<circle cx="12" cy="7" r="4"/>',
    'wrench':
        '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2.8-2.8 2.7-2.7z"/>',
    'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'x-circle':
        '<circle cx="12" cy="12" r="9"/>' +
        '<path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    'zap':
        '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
});

export const ICON_NAMES: readonly IconName[] = Object.freeze(
    Object.keys(ICON_BODIES).sort() as IconName[],
);

export function icon(name: IconName, opts: IconOptions = {}): string {
    const body = ICON_BODIES[name];
    if (body === undefined) {
        return icon('help-circle', opts);
    }

    const size = opts.size ?? 16;
    const stroke = opts.strokeWidth ?? 1.5;
    const className = opts.className !== undefined
        ? ` class="${escapeAttr(opts.className)}"`
        : '';
    const color = opts.color !== undefined
        ? ` stroke="${escapeAttr(opts.color)}"`
        : '';
    const ariaLabel = opts.ariaLabel;
    const aria = ariaLabel !== undefined
        ? ` role="img" aria-label="${escapeAttr(ariaLabel)}"`
        : ' aria-hidden="true"';

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
        ` viewBox="0 0 24 24" fill="none" stroke="currentColor"${color}` +
        ` stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"` +
        `${className}${aria} data-icon="${name}">` +
        body +
        '</svg>'
    );
}

export function iconFromEmoji(emoji: string, opts?: IconOptions): string | undefined {
    const name = EMOJI_TO_ICON[emoji];
    return name === undefined ? undefined : icon(name, opts);
}

/**
 * Boot-time hydration for static HTML. Finds every element tagged with
 * `data-icon="NAME"` (optionally `data-icon-size="N"`) and replaces its
 * contents with the matching inline SVG. Idempotent — elements already
 * containing an SVG child are skipped, and SVGs themselves (which also
 * carry `data-icon` as output attribution) are excluded.
 */
export function hydrateIcons(root: ParentNode = document): number {
    const elements = root.querySelectorAll('[data-icon]');
    let hydrated = 0;
    elements.forEach((el) => {
        if (el.namespaceURI === 'http://www.w3.org/2000/svg') return;
        if (!(el instanceof HTMLElement)) return;
        if (el.querySelector(':scope > svg') !== null) return;
        const name = el.dataset.icon;
        if (name === undefined || name === '') return;
        const sizeAttr = el.dataset.iconSize;
        const parsed = sizeAttr !== undefined ? Number.parseInt(sizeAttr, 10) : NaN;
        const size = Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
        el.innerHTML = icon(name as IconName, { size });
        hydrated++;
    });
    return hydrated;
}

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
