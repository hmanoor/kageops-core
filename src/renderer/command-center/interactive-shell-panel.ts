/**
 * KageOps — Interactive Shell Panel (B-510)
 *
 * Inline terminal: the active-input row is visually part of the output
 * stream (no border separator, same background). Clicking anywhere in
 * the terminal focuses the hidden <input> so you can type immediately.
 *
 * Per-command process model (see shell-manager.ts for spawn semantics).
 * Lines starting with `/` route to the KageOps CLI REPL.
 */

import { handleCliCommand, CLI_COMMAND_DEFS, type CliCommandDef } from './kageops-cli';

declare const kageOps: {
    shellSpawn(sessionId: string, shellType: string, cwd: string): void;
    shellInput(sessionId: string, line: string): void;
    shellKill(sessionId: string): void;
    onShellOutput(cb: (data: unknown) => void): () => void;
    onShellExit(cb: (data: unknown) => void): () => void;
};

const MAX_LINES = 3000;
let sessionCounter = 0;

function nextSessionId(): string {
    return `shell-${Date.now()}-${++sessionCounter}`;
}

interface ShellPanelState {
    sessionId: string;
    shellType: 'powershell' | 'bash' | 'cmd';
    history: string[];
    historyIdx: number;
    unsubOutput: (() => void) | null;
    unsubExit: (() => void) | null;
    lines: HTMLElement[];
    cwd: string;
}

const SHELL_LABELS: Record<string, string> = {
    powershell: 'PowerShell',
    bash: 'Bash',
    cmd: 'CMD',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
}

// ── ANSI → HTML (colour + bold, 16-colour palette) ────────────────────────────
const ANSI_RE = /\x1b\[([0-9;]*)m/g;
const COLOR_MAP_FG: Record<number, string> = {
    30: '#4a4a4a', 31: '#f28779', 32: '#87d96c', 33: '#ffd580',
    34: '#5ccfe6', 35: '#d4bfff', 36: '#5ccfe6', 37: '#cbccc6',
    90: '#6c7a86', 91: '#ff6b6b', 92: '#a3e635', 93: '#facc15',
    94: '#60a5fa', 95: '#e879f9', 96: '#22d3ee', 97: '#f8f8f2',
};

function ansiToHtml(text: string): string {
    let out = '';
    let last = 0;
    let bold = false;
    let fg: string | null = null;
    let openCount = 0;

    const closeAll = (): void => {
        while (openCount > 0) { out += '</span>'; openCount--; }
    };
    const openSpan = (): void => {
        if (!bold && fg === null) return;
        let style = '';
        if (bold) style += 'font-weight:600;';
        if (fg !== null) style += `color:${fg};`;
        out += `<span style="${style}">`;
        openCount++;
    };

    for (const m of text.matchAll(ANSI_RE)) {
        out += escHtml(text.slice(last, m.index));
        last = (m.index ?? 0) + m[0].length;
        const codes = (m[1] ?? '').split(';').map(Number);
        closeAll();
        for (const c of codes) {
            if (c === 0) { bold = false; fg = null; }
            else if (c === 1) bold = true;
            else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) fg = COLOR_MAP_FG[c] ?? null;
        }
        openSpan();
    }
    out += escHtml(text.slice(last));
    closeAll();
    return out;
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── PowerShell CLIXML / XML noise filter ─────────────────────────────────────
// -NonInteractive causes PS to serialise progress/info records as CLIXML on stderr.
// We also add $ProgressPreference at spawn time, but filter defensively here too.
const CLIXML_RE = /^#< CLIXML|^<Objs |^<Obj |^<\/Objs>|^<TN |^<TNRef |^<MS>|^<\/MS>|^<I64 |^<PR>|^<AV>|^<AI>|^<PI>|^<PC>|^<T>|^<SR>|^<SD>/;

function filterOutput(raw: string): string {
    return raw
        .split(/\r?\n/)
        .filter((line) => !CLIXML_RE.test(line.trimStart()))
        .join('\n');
}

export function initInteractiveShellPanel(host: HTMLElement): void {
    host.innerHTML = '';
    host.classList.add('ishell-host');

    // ── Toolbar: shell tabs + auxiliary buttons ───────────────────────────────
    const toolbar = el('div', 'ishell-toolbar');

    const defaultShell: ShellPanelState['shellType'] =
        navigator.platform.startsWith('Win') ? 'powershell' : 'bash';
    let pickerShell: ShellPanelState['shellType'] = defaultShell;

    // Shell tabs (Bash | PowerShell) — replace old dropdown
    const shellTabs = el('div', 'ishell-shell-tabs');
    const shellTabDefs: { id: ShellPanelState['shellType']; label: string }[] = [
        { id: 'bash', label: 'Bash' },
        { id: 'powershell', label: 'PowerShell' },
    ];
    shellTabDefs.forEach(({ id, label }) => {
        const tab = el('button', 'ishell-shell-tab');
        tab.type = 'button';
        tab.textContent = label;
        tab.dataset['shell'] = id;
        if (id === pickerShell) tab.classList.add('ishell-shell-tab--active');
        shellTabs.appendChild(tab);
    });

    const cwdSpan = el('span', 'ishell-cwd');
    cwdSpan.textContent = '';

    const clearBtn = el('button', 'ishell-btn ishell-btn--clear');
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear scrollback  (Ctrl+L)';

    const killBtn = el('button', 'ishell-btn ishell-btn--kill');
    killBtn.textContent = 'Kill';
    killBtn.title = 'Kill current process  (Ctrl+C)';
    killBtn.hidden = true;

    toolbar.appendChild(shellTabs);
    toolbar.appendChild(cwdSpan);
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(killBtn);

    // ── Terminal viewport ─────────────────────────────────────────────────────
    const viewport = el('div', 'ishell-viewport');
    viewport.style.position = 'relative';

    // Idle splash — shown before any shell is started
    const idleSplash = el('div', 'ishell-idle');
    idleSplash.innerHTML = `
        <svg class="ishell-idle-svg" viewBox="0 0 100 100" fill="none">
            <path class="ko-stroke-anim" d="M20 30 L48 30" pathLength="100"/>
            <path class="ko-stroke-anim" d="M20 46 L60 46" pathLength="100"/>
            <path class="ko-stroke-anim" d="M20 62 L52 62" pathLength="100"/>
            <path class="ko-stroke-anim" d="M20 78 L72 78" pathLength="100"/>
            <path class="ko-stroke-anim ko-stroke-anim--accent" d="M76 22 L76 84" pathLength="100"/>
        </svg>
        <div class="ko-idle-phrases" style="width:240px">
            <em class="ko-phrase" style="animation-delay:0s">Select Bash or PowerShell to open a shell.</em>
            <em class="ko-phrase" style="animation-delay:5s">Type / to run KageOps commands.</em>
            <em class="ko-phrase" style="animation-delay:10s">The terminal awaits.</em>
        </div>
        <span class="ko-idle-brand">KageOps CLI</span>`;

    const scrollback = el('div', 'ishell-scrollback');
    scrollback.setAttribute('aria-live', 'polite');

    // ── Active input line (looks like part of the output stream) ─────────────
    const activeRow = el('div', 'ishell-active-row');

    const palette = el('div', 'ishell-cmd-palette');
    palette.setAttribute('role', 'listbox');
    palette.setAttribute('aria-label', 'KageOps commands');
    palette.hidden = true;

    const promptSpan = el('span', 'ishell-prompt');
    promptSpan.setAttribute('aria-hidden', 'true');

    const cmdInput = el('input', 'ishell-input');
    cmdInput.type = 'text';
    cmdInput.autocomplete = 'off';
    cmdInput.spellcheck = false;
    cmdInput.setAttribute('aria-label', 'Terminal input');
    cmdInput.disabled = true;

    const inputMirror = el('span', 'ishell-input-mirror');

    activeRow.appendChild(palette);
    activeRow.appendChild(promptSpan);
    activeRow.appendChild(cmdInput);
    activeRow.appendChild(inputMirror);

    viewport.appendChild(idleSplash);
    viewport.appendChild(scrollback);
    viewport.appendChild(activeRow);

    host.appendChild(toolbar);
    host.appendChild(viewport);

    // ── State ─────────────────────────────────────────────────────────────────
    const state: ShellPanelState = {
        sessionId: '',
        shellType: pickerShell,
        history: [],
        historyIdx: -1,
        unsubOutput: null,
        unsubExit: null,
        lines: [],
        cwd: '~',
    };

    function updatePrompt(): void {
        const short = state.cwd.replace(/\\/g, '/').replace(/^.*\/([^/]+\/[^/]+)\/?$/, '$1');
        const label = SHELL_LABELS[state.shellType] ?? state.shellType;
        promptSpan.textContent = `${label} ${short} ❯ `;
        cwdSpan.textContent = state.cwd;
    }

    // ── Inline CLI loader ─────────────────────────────────────────────────────
    const CLI_LOADER_PHRASES = [
        'Routing to Sensei…',
        'Consulting the oracle…',
        'Dispatching the command…',
        'Querying the grid…',
        'Waking the Autonauts…',
        'Summoning an answer…',
        'Asking the shadows…',
        'Checking the wire…',
    ] as const;

    function appendLoaderRow(): () => void {
        const row = el('div', 'ishell-line--loading');
        const spinner = el('span', 'ishell-spinner');
        spinner.textContent = '◆';
        const phrase = el('span', 'ishell-loading-text');
        phrase.textContent = ' ' + (CLI_LOADER_PHRASES[Math.floor(Math.random() * CLI_LOADER_PHRASES.length)] ?? 'Routing…');
        row.appendChild(spinner);
        row.appendChild(phrase);
        scrollback.appendChild(row);
        state.lines.push(row);
        scrollToBottom();
        return (): void => {
            row.remove();
            const idx = state.lines.indexOf(row);
            if (idx !== -1) state.lines.splice(idx, 1);
        };
    }

    // ── Output helpers ────────────────────────────────────────────────────────
    function scrollToBottom(): void {
        viewport.scrollTop = viewport.scrollHeight;
    }

    function appendOutput(text: string, cls: string): void {
        const filtered = filterOutput(text);
        if (filtered.trim() === '' && text.trim() !== '') return; // all lines were CLIXML noise
        const lines = filtered.split(/\r?\n/);
        for (const raw of lines) {
            if (raw === '' && lines.length > 1) {
                // preserve blank lines between content but skip trailing blank
                if (raw === lines[lines.length - 1]) continue;
            }
            const div = el('div', cls);
            div.innerHTML = ansiToHtml(raw);
            scrollback.appendChild(div);
            state.lines.push(div);
            if (state.lines.length > MAX_LINES) {
                const oldest = state.lines.shift();
                oldest?.remove();
            }
        }
        scrollToBottom();
    }

    function appendSystem(msg: string): void {
        const div = el('div', 'ishell-line--system');
        div.textContent = msg;
        scrollback.appendChild(div);
        state.lines.push(div);
        scrollToBottom();
    }

    // ── Command palette ───────────────────────────────────────────────────────
    let paletteItems: CliCommandDef[] = [];
    let paletteIdx = 0;

    function paletteRows(): NodeListOf<HTMLElement> {
        return palette.querySelectorAll<HTMLElement>('.ishell-cmd-palette__item');
    }

    function setPaletteSelection(idx: number): void {
        const rows = paletteRows();
        paletteIdx = Math.max(0, Math.min(rows.length - 1, idx));
        rows.forEach((row, i) => {
            row.classList.toggle('ishell-cmd-palette__item--selected', i === paletteIdx);
            row.setAttribute('aria-selected', String(i === paletteIdx));
        });
        rows[paletteIdx]?.scrollIntoView({ block: 'nearest' });
    }

    function renderPalette(query: string): void {
        const q = query.toLowerCase();
        paletteItems = CLI_COMMAND_DEFS.filter((d) =>
            d.template.toLowerCase().startsWith(q) || d.label.toLowerCase().startsWith(q)
        );
        palette.innerHTML = '';
        if (paletteItems.length === 0) { palette.hidden = true; return; }
        paletteItems.forEach((def, i) => {
            const row = el('div', 'ishell-cmd-palette__item');
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(i === 0));
            if (i === 0) row.classList.add('ishell-cmd-palette__item--selected');
            const labelEl = el('span', 'ishell-cmd-palette__label');
            labelEl.textContent = def.label;
            const descEl = el('span', 'ishell-cmd-palette__desc');
            descEl.textContent = def.description;
            row.appendChild(labelEl);
            row.appendChild(descEl);
            row.addEventListener('mousedown', (e) => {
                e.preventDefault();
                applyPaletteSelection(i);
            });
            palette.appendChild(row);
        });
        paletteIdx = 0;
        palette.hidden = false;
    }

    function applyPaletteSelection(idx: number): void {
        const def = paletteItems[idx];
        if (def === undefined) return;
        cmdInput.value = def.template;
        syncMirror();
        hidePalette();
        cmdInput.focus();
        cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
    }

    function hidePalette(): void {
        palette.hidden = true;
        paletteItems = [];
    }

    // ── Mirror: sync hidden input value to the visible span ──────────────────
    function syncMirror(): void {
        inputMirror.textContent = cmdInput.value;
        // Also update palette if typing /command
        if (cmdInput.value.startsWith('/')) {
            renderPalette(cmdInput.value);
        } else {
            hidePalette();
        }
    }

    // ── IPC wiring ────────────────────────────────────────────────────────────
    function subscribeIpc(): void {
        state.unsubOutput?.();
        state.unsubExit?.();

        state.unsubOutput = kageOps.onShellOutput((data) => {
            const d = data as { sessionId: string; stream: string; data: string };
            if (d.sessionId !== state.sessionId) return;
            // Track cwd updates (injected by cd handler as \x1b[36m<path>\x1b[0m)
            const stripped = d.data.replace(/\x1b\[[0-9;]*m/g, '').trim();
            if (d.stream === 'stdout' && stripped.match(/^[A-Z]:[/\\]|^\//)) {
                state.cwd = stripped.replace(/\\/g, '/');
                updatePrompt();
            }
            const cls = d.stream === 'stderr' ? 'ishell-line--stderr' : 'ishell-line--stdout';
            appendOutput(d.data, cls);
        });

        state.unsubExit = kageOps.onShellExit((data) => {
            const d = data as { sessionId: string; code: number };
            if (d.sessionId !== state.sessionId) return;
            appendSystem(`[Process exited — press Enter to restart]`);
            killBtn.hidden = true;
            cmdInput.disabled = true;
            inputMirror.textContent = '';
            promptSpan.textContent = '❯ ';
        });
    }

    // ── Spawn ─────────────────────────────────────────────────────────────────
    function startShell(): void {
        if (state.sessionId !== '') kageOps.shellKill(state.sessionId);
        state.sessionId = nextSessionId();
        state.shellType = pickerShell;
        state.cwd = '~';

        subscribeIpc();
        kageOps.shellSpawn(state.sessionId, state.shellType, '');

        idleSplash.hidden = true;
        killBtn.hidden = false;
        cmdInput.disabled = false;
        cmdInput.value = '';
        inputMirror.textContent = '';
        updatePrompt();
        appendSystem(`[Starting ${SHELL_LABELS[state.shellType] ?? state.shellType}…]`);

        // Startup loader: clears on first shell output OR 2 s fallback
        const stopStartupLoader = appendLoaderRow();
        let cleared = false;
        const clear = (): void => { if (cleared) return; cleared = true; stopStartupLoader(); };
        const timer = setTimeout(clear, 2000);
        const unsub = kageOps.onShellOutput((data) => {
            const d = data as { sessionId: string };
            if (d.sessionId === state.sessionId) { clearTimeout(timer); clear(); unsub(); }
        });

        cmdInput.focus();
    }

    // ── Controls ──────────────────────────────────────────────────────────────
    shellTabs.addEventListener('click', (e) => {
        const tab = (e.target as HTMLElement).closest<HTMLElement>('.ishell-shell-tab');
        if (tab === null) return;
        const chosen = tab.dataset['shell'] as ShellPanelState['shellType'];
        const switching = chosen !== pickerShell && state.sessionId !== '';
        pickerShell = chosen;
        shellTabs.querySelectorAll<HTMLElement>('.ishell-shell-tab').forEach((t) => {
            t.classList.toggle('ishell-shell-tab--active', t.dataset['shell'] === chosen);
        });
        if (switching) appendSystem(`[Switching to ${SHELL_LABELS[pickerShell] ?? pickerShell}…]`);
        startShell();
    });

    function clearTerminal(): void {
        scrollback.innerHTML = '';
        state.lines.length = 0;
    }

    clearBtn.addEventListener('click', clearTerminal);

    killBtn.addEventListener('click', () => {
        if (state.sessionId !== '') kageOps.shellKill(state.sessionId);
    });

    // Click anywhere in the viewport → focus input
    viewport.addEventListener('click', (e) => {
        // Don't steal focus from toolbar buttons or palette items
        const target = e.target as HTMLElement;
        if (target.closest('.ishell-toolbar, .ishell-cmd-palette')) return;
        cmdInput.focus();
    });

    // ── Input handling ────────────────────────────────────────────────────────
    cmdInput.addEventListener('input', syncMirror);

    cmdInput.addEventListener('blur', () => {
        setTimeout(() => hidePalette(), 120);
    });

    cmdInput.addEventListener('keydown', (e) => {
        // ── Ctrl+L: clear ──
        if (e.key === 'l' && e.ctrlKey) {
            e.preventDefault();
            clearTerminal();
            return;
        }

        // ── Palette navigation ──
        if (!palette.hidden) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteSelection(paletteIdx + 1); return; }
            if (e.key === 'ArrowUp')   { e.preventDefault(); setPaletteSelection(paletteIdx - 1); return; }
            if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault();
                applyPaletteSelection(paletteIdx);
                if (e.key === 'Enter') {
                    const def = paletteItems[paletteIdx];
                    if (def !== undefined && !def.template.endsWith(' ')) {
                        setTimeout(() => cmdInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 0);
                    }
                }
                return;
            }
            if (e.key === 'Escape') { e.preventDefault(); hidePalette(); return; }
        }

        // ── Shell / history handling ──
        if (e.key === 'Enter') {
            const line = cmdInput.value;
            cmdInput.value = '';
            inputMirror.textContent = '';
            hidePalette();
            state.historyIdx = -1;

            if (cmdInput.disabled) { startShell(); return; }
            if (line.trim() === '') return;

            state.history.unshift(line);
            if (state.history.length > 200) state.history.pop();

            // Echo the command as part of the output stream
            const echo = el('div', 'ishell-line--echo');
            echo.textContent = `${promptSpan.textContent}${line}`;
            scrollback.appendChild(echo);
            state.lines.push(echo);
            scrollToBottom();

            if (line.trim().startsWith('/')) {
                const stopLoader = appendLoaderRow();
                const minVisible = new Promise<void>((r) => setTimeout(r, 400));
                void Promise.all([
                    handleCliCommand(line, appendOutput, appendSystem),
                    minVisible,
                ]).then(stopLoader);
            } else {
                kageOps.shellInput(state.sessionId, line);
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (state.history.length === 0) return;
            state.historyIdx = Math.min(state.historyIdx + 1, state.history.length - 1);
            cmdInput.value = state.history[state.historyIdx] ?? '';
            syncMirror();
            cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            state.historyIdx = Math.max(state.historyIdx - 1, -1);
            cmdInput.value = state.historyIdx >= 0 ? (state.history[state.historyIdx] ?? '') : '';
            syncMirror();
            cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
        } else if (e.key === 'c' && e.ctrlKey) {
            if (state.sessionId !== '') kageOps.shellKill(state.sessionId);
        }
    });

    // Shell starts when the user clicks a tab (Bash / PowerShell)
    // — no auto-start so the idle splash is shown first.
    promptSpan.textContent = '❯ ';
}
