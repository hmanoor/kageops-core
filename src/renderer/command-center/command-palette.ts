/**
 * KageOps Command Center — Command Palette (Track C)
 *
 * Linear-inspired global launcher. Triggered by ⌘K / Ctrl+K. Overlay
 * mounted at <body>, centered, with backdrop blur. Fuzzy match over
 * commands grouped into sections, keyboard-first, focus-trapped.
 *
 * Public API:
 *   initCommandPalette()          — register global keybinding, mount DOM.
 *   openCommandPalette()          — open programmatically.
 *   closeCommandPalette()         — close programmatically.
 *   registerCommand({...})        — append a command; id is unique.
 *   unregisterCommand(id)         — remove by id.
 *
 * Keep this file < 500 lines.
 */

import { icon, type IconName } from '../../shared/icons';

// ── Public types ────────────────────────────────────────

export type CommandSection = 'go-to' | 'actions' | 'recent';

export interface PaletteCommand {
    readonly id: string;
    readonly title: string;
    readonly section: CommandSection;
    readonly keywords?: readonly string[];
    readonly icon?: IconName;
    readonly subtitle?: string;
    readonly shortcut?: string;
    readonly run: () => void | Promise<void>;
}

// ── State ───────────────────────────────────────────────

interface PaletteDOM {
    readonly root: HTMLDivElement;
    readonly backdrop: HTMLDivElement;
    readonly dialog: HTMLDivElement;
    readonly input: HTMLInputElement;
    readonly list: HTMLDivElement;
    readonly empty: HTMLDivElement;
}

const commands = new Map<string, PaletteCommand>();
const SECTION_ORDER: readonly CommandSection[] = ['go-to', 'actions', 'recent'];
const SECTION_LABEL: Readonly<Record<CommandSection, string>> = Object.freeze({
    'go-to': 'Go to',
    'actions': 'Actions',
    'recent': 'Recent projects',
});

let dom: PaletteDOM | null = null;
let isOpen = false;
let visibleRows: HTMLElement[] = [];
let selectedIndex = 0;
let previouslyFocused: HTMLElement | null = null;

// ── Public API ──────────────────────────────────────────

export function initCommandPalette(): void {
    if (dom !== null) return;
    dom = mountDOM();

    document.addEventListener('keydown', (ev) => {
        const isMod = ev.metaKey || ev.ctrlKey;
        if (!isMod) return;
        if (ev.key !== 'k' && ev.key !== 'K') return;
        ev.preventDefault();
        if (isOpen) {
            closeCommandPalette();
        } else {
            openCommandPalette();
        }
    });
}

export function registerCommand(cmd: PaletteCommand): void {
    if (cmd.id === '' || cmd.title === '') {
        console.warn('[CommandPalette] ignoring command with empty id/title');
        return;
    }
    commands.set(cmd.id, cmd);
    if (isOpen) render();
}

export function unregisterCommand(id: string): void {
    commands.delete(id);
    if (isOpen) render();
}

export function openCommandPalette(): void {
    if (dom === null) return;
    if (isOpen) return;

    previouslyFocused = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    isOpen = true;
    dom.root.hidden = false;
    dom.root.classList.add('is-open');
    dom.input.value = '';
    selectedIndex = 0;
    render();

    // Defer focus so the animation frame paints the modal first.
    requestAnimationFrame(() => {
        dom?.input.focus();
    });
}

export function closeCommandPalette(): void {
    if (dom === null) return;
    if (!isOpen) return;
    isOpen = false;
    dom.root.classList.remove('is-open');
    dom.root.hidden = true;
    if (previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
    }
    previouslyFocused = null;
}

// ── DOM construction ────────────────────────────────────

function mountDOM(): PaletteDOM {
    const root = document.createElement('div');
    root.className = 'cmdk';
    root.setAttribute('role', 'presentation');
    root.hidden = true;

    const backdrop = document.createElement('div');
    backdrop.className = 'cmdk__backdrop';
    backdrop.addEventListener('click', () => closeCommandPalette());

    const dialog = document.createElement('div');
    dialog.className = 'cmdk__dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Command palette');

    const inputWrap = document.createElement('div');
    inputWrap.className = 'cmdk__input-wrap';
    inputWrap.innerHTML =
        `<span class="cmdk__input-icon">${icon('search', { size: 16 })}</span>`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cmdk__input';
    input.placeholder = 'Type a command or search…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Command search');
    input.setAttribute('aria-controls', 'cmdk-list');
    input.setAttribute('aria-autocomplete', 'list');
    inputWrap.appendChild(input);

    const kbd = document.createElement('kbd');
    kbd.className = 'cmdk__input-hint';
    kbd.textContent = 'Esc';
    inputWrap.appendChild(kbd);

    const list = document.createElement('div');
    list.className = 'cmdk__list';
    list.id = 'cmdk-list';
    list.setAttribute('role', 'listbox');

    const empty = document.createElement('div');
    empty.className = 'cmdk__empty';
    empty.textContent = 'No matches.';
    empty.hidden = true;

    dialog.appendChild(inputWrap);
    dialog.appendChild(list);
    dialog.appendChild(empty);

    root.appendChild(backdrop);
    root.appendChild(dialog);
    document.body.appendChild(root);

    input.addEventListener('input', () => {
        selectedIndex = 0;
        render();
    });

    input.addEventListener('keydown', onInputKey);
    dialog.addEventListener('keydown', trapTab);

    return { root, backdrop, dialog, input, list, empty };
}

function onInputKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
        ev.preventDefault();
        closeCommandPalette();
        return;
    }
    if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        moveSelection(1);
        return;
    }
    if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        moveSelection(-1);
        return;
    }
    if (ev.key === 'Enter') {
        ev.preventDefault();
        void runSelected();
    }
}

function trapTab(ev: KeyboardEvent): void {
    if (ev.key !== 'Tab') return;
    if (dom === null) return;
    // Palette has exactly one focusable element (the input). Keep focus on it.
    ev.preventDefault();
    dom.input.focus();
}

// ── Rendering ───────────────────────────────────────────

function render(): void {
    if (dom === null) return;
    const query = dom.input.value.trim().toLowerCase();

    const all = Array.from(commands.values());
    const matches = query === ''
        ? all.map((cmd) => ({ cmd, score: scoreCommand(cmd, '') }))
        : all
            .map((cmd) => ({ cmd, score: scoreCommand(cmd, query) }))
            .filter((m) => m.score > 0);

    matches.sort(compareMatches);

    dom.list.innerHTML = '';
    visibleRows = [];

    if (matches.length === 0) {
        dom.list.hidden = true;
        dom.empty.hidden = false;
        return;
    }
    dom.list.hidden = false;
    dom.empty.hidden = true;

    let currentSection: CommandSection | null = null;
    for (const { cmd } of matches) {
        if (cmd.section !== currentSection) {
            currentSection = cmd.section;
            const header = document.createElement('div');
            header.className = 'cmdk__section';
            header.setAttribute('role', 'presentation');
            header.textContent = SECTION_LABEL[cmd.section];
            dom.list.appendChild(header);
        }
        const row = buildRow(cmd);
        dom.list.appendChild(row);
        visibleRows.push(row);
    }

    if (selectedIndex >= visibleRows.length) {
        selectedIndex = 0;
    }
    applySelection();
}

function buildRow(cmd: PaletteCommand): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cmdk__row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.dataset['commandId'] = cmd.id;

    const iconHtml = cmd.icon !== undefined ? icon(cmd.icon, { size: 16 }) : '';
    const shortcutHtml = cmd.shortcut !== undefined
        ? `<kbd class="cmdk__kbd">${escapeHtml(cmd.shortcut)}</kbd>`
        : '';
    const subtitleHtml = cmd.subtitle !== undefined && cmd.subtitle !== ''
        ? `<span class="cmdk__row-subtitle">${escapeHtml(cmd.subtitle)}</span>`
        : '';

    row.innerHTML =
        `<span class="cmdk__row-icon">${iconHtml}</span>` +
        `<span class="cmdk__row-label">${escapeHtml(cmd.title)}${subtitleHtml}</span>` +
        `<span class="cmdk__row-shortcut">${shortcutHtml}</span>`;

    row.addEventListener('click', () => {
        void executeCommand(cmd);
    });
    row.addEventListener('mousemove', () => {
        const idx = visibleRows.indexOf(row);
        if (idx >= 0 && idx !== selectedIndex) {
            selectedIndex = idx;
            applySelection();
        }
    });
    return row;
}

function applySelection(): void {
    visibleRows.forEach((row, i) => {
        const selected = i === selectedIndex;
        row.classList.toggle('is-selected', selected);
        row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    const active = visibleRows[selectedIndex];
    if (active !== undefined) {
        active.scrollIntoView({ block: 'nearest' });
    }
}

function moveSelection(delta: number): void {
    if (visibleRows.length === 0) return;
    const n = visibleRows.length;
    selectedIndex = (selectedIndex + delta + n) % n;
    applySelection();
}

async function runSelected(): Promise<void> {
    const row = visibleRows[selectedIndex];
    if (row === undefined) return;
    const id = row.dataset['commandId'] ?? '';
    const cmd = commands.get(id);
    if (cmd === undefined) return;
    await executeCommand(cmd);
}

async function executeCommand(cmd: PaletteCommand): Promise<void> {
    closeCommandPalette();
    try {
        await cmd.run();
    } catch (err) {
        console.error(
            '[CommandPalette] command failed:',
            cmd.id,
            err instanceof Error ? err.message : String(err),
        );
    }
}

// ── Fuzzy match ─────────────────────────────────────────

/**
 * Simple character-skip fuzzy match. Returns 0 when the query doesn't
 * match, a positive score otherwise. Higher = better.
 */
function scoreCommand(cmd: PaletteCommand, query: string): number {
    if (query === '') {
        // No query — rank purely by section priority so the list is stable.
        return 100 - sectionIndex(cmd.section);
    }
    const haystacks: readonly string[] = [
        cmd.title.toLowerCase(),
        ...(cmd.keywords ?? []).map((k) => k.toLowerCase()),
        cmd.subtitle?.toLowerCase() ?? '',
    ];
    let best = 0;
    for (const hay of haystacks) {
        if (hay === '') continue;
        const s = fuzzyScore(hay, query);
        if (s > best) best = s;
    }
    return best;
}

function fuzzyScore(hay: string, query: string): number {
    // Exact prefix bonus — matches feel most natural.
    if (hay.startsWith(query)) return 1000 - (hay.length - query.length);
    if (hay.includes(query)) return 600 - (hay.length - query.length);

    // Character-skip match: advance through hay, matching each query char
    // in order. Consecutive runs score higher.
    let h = 0;
    let q = 0;
    let score = 0;
    let streak = 0;
    while (h < hay.length && q < query.length) {
        if (hay[h] === query[q]) {
            streak += 1;
            score += 5 + streak * 2;
            q += 1;
        } else {
            streak = 0;
        }
        h += 1;
    }
    return q === query.length ? score : 0;
}

function compareMatches(
    a: { cmd: PaletteCommand; score: number },
    b: { cmd: PaletteCommand; score: number },
): number {
    const sa = sectionIndex(a.cmd.section);
    const sb = sectionIndex(b.cmd.section);
    if (sa !== sb) return sa - sb;
    if (a.score !== b.score) return b.score - a.score;
    return a.cmd.title.localeCompare(b.cmd.title);
}

function sectionIndex(section: CommandSection): number {
    const idx = SECTION_ORDER.indexOf(section);
    return idx < 0 ? SECTION_ORDER.length : idx;
}

// ── Utilities ───────────────────────────────────────────

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
