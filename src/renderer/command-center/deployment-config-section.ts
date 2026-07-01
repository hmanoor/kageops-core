/**
 * Pillar 2.2 / PR-B.2 — New-Project modal Deployment Configuration section.
 *
 * Renders entirely from the bundle manifest's `deployment` block (PR-A).
 * No hard-coded provider knowledge in the renderer — new bundles get
 * the UX for free.
 *
 * Operator-facing affordances landed by this module (per the 15 plan
 * decisions):
 *
 *   • D-A  Bundle picker drives section render (mount(bundle))
 *   • D-B  "Skip for now" toggle — collectValues() returns null
 *   • D-E  Vercel token field with F-313 keychain badge UX
 *   • D-L  Per-field [Get →] (signup_url|dashboard_url), [Docs ↗],
 *          format_hint placeholder, live regex validation,
 *          reveal toggle on secret fields, inline ⓘ tooltip
 *   • D-M  Collapsible "First time setting up <bundle>?" checklist,
 *          auto-collapses once every step is checked
 *   • D-N  Per-field [Test] button → IPC `testSecret`, closed-set
 *          SecretTestCode mapping (never surfaces raw vendor errors)
 *
 * Pure DOM — no framework. All state held on private fields of the
 * class instance. Two top-level public methods:
 *
 *   • mountInto(container, bundle, opts)  — render the section
 *   • collectValues()                      — read current form state
 *
 * The IPC bridge is injected via `DeploymentConfigBridge` so jsdom
 * tests can stub network + keychain calls.
 */

// ── Types ────────────────────────────────────────────

export interface BundleDeploymentEnvVar {
    readonly key: string;
    readonly label: string;
    readonly help?: string;
    readonly secret?: boolean;
    readonly signup_url?: string;
    readonly dashboard_url?: string;
    readonly docs_url?: string;
    readonly format_hint?: string;
    readonly format_regex?: string;
}

export interface BundleDeploymentProviderHelp {
    readonly signup_url?: string;
    readonly token_url?: string;
    readonly docs_url?: string;
    readonly token_scope?: string;
}

export interface BundleDeployment {
    readonly provider: 'vercel';
    readonly provider_help?: BundleDeploymentProviderHelp;
    readonly required_env?: readonly BundleDeploymentEnvVar[];
    readonly optional_env?: readonly BundleDeploymentEnvVar[];
}

export interface BundleSummary {
    readonly name: string;
    readonly kind: 'stack' | 'capability' | 'deployer';
    readonly description: string;
    readonly deployment: BundleDeployment | null;
}

export type SecretTestCode =
    | 'valid'
    | 'invalid_format'
    | 'unauthorized'
    | 'forbidden'
    | 'network'
    | 'unknown';

export interface SecretTestResult {
    readonly code: SecretTestCode;
    readonly latencyMs: number;
    readonly identity?: string;
}

/**
 * Renderer → main bridge. Production wires this to `window.kageOps.*`;
 * tests inject deterministic stubs.
 */
export interface DeploymentConfigBridge {
    readonly getVercelTokenStatus: () => Promise<{ success: boolean; present: boolean }>;
    readonly saveVercelToken: (token: string) => Promise<{ success: boolean; error?: string }>;
    readonly clearVercelToken: () => Promise<{ success: boolean; error?: string }>;
    readonly testSecret: (
        provider: string,
        value: string
    ) => Promise<{ success: boolean; result?: SecretTestResult; error?: string }>;
    readonly openVendorUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Result of `collectValues()`. `null` means operator ticked
 * "Skip for now" (D-B) — caller must NOT persist a config blob.
 */
export interface DeploymentConfigCollected {
    readonly values: Readonly<Record<string, string>>;
    /** All required fields present + format-valid? */
    readonly allRequiredFilled: boolean;
    /**
     * Phase 2b — operator ticked "Save to key register": persist `values` to
     * the OS keychain so future runs of this project pick them up. The caller
     * makes the keychain call once the project id exists.
     */
    readonly saveToKeyRegister: boolean;
}

export interface MountOptions {
    /** Initial state from a previous session (rare for new-project flow). */
    readonly initialValues?: Readonly<Record<string, string>>;
    readonly initialSkip?: boolean;
    /**
     * Which run mode to open on. `'local'` (default) presents a clean,
     * account-free flow — KageOps builds + runs the app on this machine and
     * `collectValues()` returns null (nothing to deploy). `'deploy'` reveals
     * the Vercel token + app-secret fields. The New-Project modal opens on
     * `'local'`; deploy is one click away.
     */
    readonly initialMode?: DeployMode;
}

export type DeployMode = 'local' | 'deploy';

// ── Helpers ──────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Partial<HTMLElementTagNameMap[K]> & { className?: string; dataset?: Record<string, string> } = {},
    children: ReadonlyArray<Node | string> = []
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'dataset' && v !== undefined) {
            for (const [dk, dv] of Object.entries(v as Record<string, string>)) {
                node.dataset[dk] = dv;
            }
        } else if (k === 'className' && typeof v === 'string') {
            node.className = v;
        } else if (k in node) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (node as any)[k] = v;
        }
    }
    for (const c of children) {
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

function compileRegexSafely(pattern: string | undefined): RegExp | null {
    if (pattern === undefined || pattern.length === 0) return null;
    try {
        return new RegExp(pattern);
    } catch {
        return null;
    }
}

const TEST_CODE_LABELS: Readonly<Record<SecretTestCode, string>> = {
    valid: '✓ Valid',
    invalid_format: '✗ Bad format',
    unauthorized: '✗ Unauthorized',
    forbidden: '✗ Forbidden',
    network: '✗ Network error',
    unknown: '? Unknown',
};

function statusClass(code: SecretTestCode): string {
    return code === 'valid' ? 'deploy-status--valid' : 'deploy-status--bad';
}

// ── Section class ────────────────────────────────────

export class DeploymentConfigSection {
    private readonly bridge: DeploymentConfigBridge;

    private container: HTMLElement | null = null;
    private mountedBundle: BundleSummary | null = null;
    private skipToggle: HTMLInputElement | null = null;
    private fieldInputs = new Map<string, HTMLInputElement>();
    private fieldStatusEls = new Map<string, HTMLElement>();
    private setupSteps: HTMLInputElement[] = [];
    private vercelTokenInput: HTMLInputElement | null = null;
    private vercelTokenBadge: HTMLElement | null = null;
    private deployMode: DeployMode = 'local';
    private deployFieldsWrap: HTMLElement | null = null;
    private keyRegisterToggle: HTMLInputElement | null = null;

    constructor(bridge: DeploymentConfigBridge) {
        this.bridge = bridge;
    }

    /**
     * Render the section into `container`. Safe to call repeatedly —
     * each call wipes the container and re-renders for the new bundle.
     * When `bundle.deployment` is null, the section renders an empty
     * "no deployment config needed for this bundle" notice instead.
     */
    async mountInto(
        container: HTMLElement,
        bundle: BundleSummary | null,
        opts: MountOptions = {}
    ): Promise<void> {
        this.container = container;
        this.mountedBundle = bundle;
        this.fieldInputs.clear();
        this.fieldStatusEls.clear();
        this.setupSteps = [];
        this.skipToggle = null;
        this.vercelTokenInput = null;
        this.vercelTokenBadge = null;
        this.deployFieldsWrap = null;
        this.keyRegisterToggle = null;
        this.deployMode = opts.initialMode ?? 'local';

        container.innerHTML = '';

        if (bundle === null || bundle.deployment === null) {
            container.appendChild(
                el('p', { className: 'deploy-empty' }, [
                    bundle === null
                        ? 'Pick a project type to configure deployment.'
                        : 'This project type does not need a deploy configuration.',
                ])
            );
            return;
        }

        const dep = bundle.deployment;

        container.appendChild(this.buildHeader(bundle, dep));
        container.appendChild(this.buildModeToggle());

        // Everything below the toggle is deploy-only — wrapped so a single
        // style flip hides it in "Run locally" mode (kept in the DOM so
        // re-selecting "Deploy" restores the exact same field state).
        const fields = el('div', { className: 'deploy-fields', dataset: { deployFields: '' } });
        this.deployFieldsWrap = fields;
        fields.appendChild(this.buildSetupChecklist(bundle, dep));
        fields.appendChild(await this.buildProviderTokenRow(dep));
        for (const env of dep.required_env ?? []) {
            fields.appendChild(this.buildEnvRow(env, false, opts.initialValues));
        }
        for (const env of dep.optional_env ?? []) {
            fields.appendChild(this.buildEnvRow(env, true, opts.initialValues));
        }
        fields.appendChild(this.buildSkipToggle(opts.initialSkip ?? false));
        fields.appendChild(this.buildKeyRegisterToggle());
        container.appendChild(fields);

        this.applyDeployModeVisibility();
    }

    /**
     * Read the current form state. Returns `null` when "Skip for now"
     * is checked OR when the bundle has no deployment block.
     */
    collectValues(): DeploymentConfigCollected | null {
        if (this.mountedBundle === null || this.mountedBundle.deployment === null) {
            return null;
        }
        // "Run locally" → nothing to deploy; behaves like an implicit skip.
        if (this.deployMode === 'local') {
            return null;
        }
        if (this.skipToggle?.checked === true) {
            return null;
        }

        const values: Record<string, string> = {};
        const dep = this.mountedBundle.deployment;
        let allRequiredFilled = true;
        for (const env of dep.required_env ?? []) {
            const input = this.fieldInputs.get(env.key);
            const v = (input?.value ?? '').trim();
            if (v.length > 0) {
                values[env.key] = v;
            }
            if (v.length === 0 || !this.passesFormat(env, v)) {
                allRequiredFilled = false;
            }
        }
        for (const env of dep.optional_env ?? []) {
            const input = this.fieldInputs.get(env.key);
            const v = (input?.value ?? '').trim();
            if (v.length > 0 && this.passesFormat(env, v)) {
                values[env.key] = v;
            }
        }

        return {
            values,
            allRequiredFilled,
            saveToKeyRegister: this.keyRegisterToggle?.checked === true,
        };
    }

    /** True when "Skip for now" is ticked — caller hides the deploy step. */
    isSkipped(): boolean {
        return this.skipToggle?.checked === true;
    }

    /** Current run mode — `'local'` (build + run here) or `'deploy'` (to Vercel). */
    currentMode(): DeployMode {
        return this.deployMode;
    }

    // ── Builders ────────────────────────────────────

    private buildHeader(bundle: BundleSummary, dep: BundleDeployment): HTMLElement {
        return el('div', { className: 'deploy-header' }, [
            el('h3', { className: 'deploy-header-title' }, [
                'Deployment configuration — ',
                el('span', { className: 'deploy-provider-name' }, [dep.provider]),
            ]),
            el('p', { className: 'deploy-header-sub' }, [
                'These values let KageOps deploy ',
                el('strong', {}, [bundle.name]),
                ' to a live preview URL after the build passes.',
            ]),
        ]);
    }

    /**
     * "Where should this run?" segmented control. Two exclusive buttons —
     * Run locally (default) and Deploy to Vercel. Clicking flips
     * `deployMode` and re-applies visibility; no re-mount needed.
     */
    private buildModeToggle(): HTMLElement {
        const wrap = el('div', { className: 'deploy-mode', dataset: { deployModeToggle: '' } });
        wrap.appendChild(
            el('span', { className: 'deploy-mode-label' }, ['Where should this run?'])
        );

        const seg = el('div', { className: 'deploy-mode-seg', role: 'radiogroup' });
        const mkBtn = (mode: DeployMode, text: string): HTMLButtonElement => {
            const btn = el('button', {
                type: 'button',
                className: 'deploy-mode-seg-btn',
                dataset: { deployMode: mode },
            }, [text]);
            btn.addEventListener('click', () => this.setDeployMode(mode));
            return btn;
        };
        seg.appendChild(mkBtn('local', 'Run locally'));
        seg.appendChild(mkBtn('deploy', 'Deploy to Vercel'));
        wrap.appendChild(seg);

        wrap.appendChild(
            el('p', { className: 'deploy-mode-hint', dataset: { deployModeHint: '' } }, [
                this.modeHintText(),
            ])
        );
        return wrap;
    }

    private setDeployMode(mode: DeployMode): void {
        if (mode === this.deployMode) return;
        this.deployMode = mode;
        this.applyDeployModeVisibility();
    }

    /** Reflect `deployMode` in the DOM: field visibility + button/hint state. */
    private applyDeployModeVisibility(): void {
        if (this.deployFieldsWrap !== null) {
            this.deployFieldsWrap.style.display = this.deployMode === 'deploy' ? '' : 'none';
        }
        for (const node of this.container?.querySelectorAll<HTMLElement>('[data-deploy-mode]') ?? []) {
            const active = node.dataset['deployMode'] === this.deployMode;
            node.classList.toggle('deploy-mode-seg-btn--active', active);
            node.setAttribute('aria-pressed', String(active));
        }
        const hint = this.container?.querySelector('[data-deploy-mode-hint]');
        if (hint !== null && hint !== undefined) {
            hint.textContent = this.modeHintText();
        }
    }

    private modeHintText(): string {
        return this.deployMode === 'deploy'
            ? 'KageOps deploys your app to Vercel after the build passes. Add your Vercel token and the app secrets below.'
            : 'KageOps builds your app and runs it on this machine — no accounts or tokens needed. You can switch to Deploy any time.';
    }

    private buildSetupChecklist(
        bundle: BundleSummary,
        dep: BundleDeployment
    ): HTMLElement {
        // D-M sourcing: walk provider_help + each env's signup_url to find
        // distinct vendors. Dedupe by URL origin.
        type Step = { label: string; url: string };
        const steps: Step[] = [];
        const seen = new Set<string>();
        const push = (label: string, url: string | undefined) => {
            if (url === undefined || url.length === 0) return;
            let origin: string;
            try {
                origin = new URL(url).origin;
            } catch {
                return;
            }
            if (seen.has(origin)) return;
            seen.add(origin);
            steps.push({ label, url });
        };
        push(`Create a ${dep.provider} account`, dep.provider_help?.signup_url);
        for (const env of dep.required_env ?? []) {
            push(`Account for ${env.label}`, env.signup_url);
        }

        if (steps.length === 0) {
            return el('div', { className: 'deploy-setup-checklist deploy-setup-checklist--empty' });
        }

        const wrap = el('details', { className: 'deploy-setup-checklist', open: true });
        wrap.appendChild(
            el('summary', { className: 'deploy-setup-summary' }, [
                `First time setting up ${bundle.name}?`,
            ])
        );

        const list = el('ul', { className: 'deploy-setup-steps' });
        for (const step of steps) {
            const checkbox = el('input', { type: 'checkbox', className: 'deploy-setup-step-tick' });
            checkbox.addEventListener('change', () => this.maybeCollapseSetup(wrap));
            this.setupSteps.push(checkbox);

            const link = el('button', {
                type: 'button',
                className: 'deploy-setup-step-link',
            }, ['Sign up →']);
            link.addEventListener('click', (e) => {
                e.preventDefault();
                void this.bridge.openVendorUrl(step.url);
            });

            list.appendChild(
                el('li', { className: 'deploy-setup-step' }, [
                    el('label', { className: 'deploy-setup-step-label' }, [
                        checkbox,
                        ' ',
                        step.label,
                    ]),
                    link,
                ])
            );
        }
        wrap.appendChild(list);
        return wrap;
    }

    private async buildProviderTokenRow(dep: BundleDeployment): Promise<HTMLElement> {
        const wrap = el('div', { className: 'deploy-row deploy-row--provider-token' });
        wrap.appendChild(
            el('label', { className: 'deploy-row-label' }, [`${dep.provider} token`])
        );

        const inputWrap = el('div', { className: 'deploy-row-input-wrap' });
        const input = el('input', {
            type: 'password',
            className: 'deploy-input deploy-input--token',
            placeholder: 'Paste your token here',
            autocomplete: 'off',
        });
        this.vercelTokenInput = input;
        inputWrap.appendChild(input);

        const badge = el('span', { className: 'deploy-token-badge deploy-token-badge--unknown' }, [
            'Checking…',
        ]);
        this.vercelTokenBadge = badge;
        inputWrap.appendChild(badge);

        const saveBtn = el('button', { type: 'button', className: 'deploy-btn deploy-btn--secondary' }, [
            'Save',
        ]);
        saveBtn.addEventListener('click', async () => {
            const token = input.value.trim();
            if (token.length === 0) return;
            const res = await this.bridge.saveVercelToken(token);
            if (res.success) {
                input.value = '';
                this.setTokenBadge('saved');
            } else {
                this.setTokenBadge('error');
            }
        });
        inputWrap.appendChild(saveBtn);

        const replaceBtn = el('button', { type: 'button', className: 'deploy-btn deploy-btn--ghost' }, [
            'Replace',
        ]);
        replaceBtn.addEventListener('click', async () => {
            await this.bridge.clearVercelToken();
            this.setTokenBadge('empty');
        });
        inputWrap.appendChild(replaceBtn);

        wrap.appendChild(inputWrap);

        // Vendor help links (D-L for provider-level)
        const linkRow = el('div', { className: 'deploy-row-links' });
        if (dep.provider_help?.token_url !== undefined) {
            linkRow.appendChild(this.buildVendorLink('Get token →', dep.provider_help.token_url));
        }
        if (dep.provider_help?.docs_url !== undefined) {
            linkRow.appendChild(this.buildVendorLink('Docs ↗', dep.provider_help.docs_url));
        }
        if (dep.provider_help?.token_scope !== undefined) {
            linkRow.appendChild(
                el('span', { className: 'deploy-row-hint' }, [
                    `Scope: ${dep.provider_help.token_scope}`,
                ])
            );
        }
        wrap.appendChild(linkRow);

        // Read current keychain state once on mount; UI reflects it.
        try {
            const status = await this.bridge.getVercelTokenStatus();
            this.setTokenBadge(status.present ? 'saved' : 'empty');
        } catch {
            this.setTokenBadge('error');
        }

        return wrap;
    }

    private buildEnvRow(
        env: BundleDeploymentEnvVar,
        isOptional: boolean,
        initialValues: Readonly<Record<string, string>> | undefined
    ): HTMLElement {
        const wrap = el('div', { className: 'deploy-row deploy-row--env' });
        wrap.dataset.envKey = env.key;

        const labelText = isOptional ? `${env.label} (optional)` : env.label;
        wrap.appendChild(
            el('label', {
                className: 'deploy-row-label',
                htmlFor: `deploy-env-${env.key}`,
            }, [labelText])
        );

        const inputWrap = el('div', { className: 'deploy-row-input-wrap' });
        const input = el('input', {
            id: `deploy-env-${env.key}`,
            type: env.secret === true ? 'password' : 'text',
            className: 'deploy-input',
            placeholder: env.format_hint ?? '',
            autocomplete: 'off',
            value: initialValues?.[env.key] ?? '',
        });
        this.fieldInputs.set(env.key, input);
        inputWrap.appendChild(input);

        if (env.secret === true) {
            const reveal = el('button', {
                type: 'button',
                className: 'deploy-btn deploy-btn--reveal',
                title: 'Show / hide',
            }, ['👁']);
            reveal.addEventListener('click', () => {
                input.type = input.type === 'password' ? 'text' : 'password';
            });
            inputWrap.appendChild(reveal);
        }

        const testBtn = el('button', { type: 'button', className: 'deploy-btn deploy-btn--secondary' }, [
            'Test',
        ]);
        const status = el('span', { className: 'deploy-status deploy-status--idle' });
        this.fieldStatusEls.set(env.key, status);
        testBtn.addEventListener('click', () => {
            void this.runTest(env, input, status, testBtn);
        });
        inputWrap.appendChild(testBtn);
        inputWrap.appendChild(status);

        wrap.appendChild(inputWrap);

        // Live format validation.
        const regex = compileRegexSafely(env.format_regex);
        if (regex !== null) {
            input.addEventListener('input', () => {
                const v = input.value.trim();
                if (v.length === 0) {
                    input.classList.remove('deploy-input--bad');
                    return;
                }
                if (regex.test(v)) {
                    input.classList.remove('deploy-input--bad');
                } else {
                    input.classList.add('deploy-input--bad');
                }
            });
        }

        // Help + vendor link strip.
        const helpRow = el('div', { className: 'deploy-row-links' });
        if (env.help !== undefined && env.help.length > 0) {
            helpRow.appendChild(el('span', { className: 'deploy-row-hint' }, [env.help]));
        }
        const target = env.dashboard_url ?? env.signup_url;
        if (target !== undefined) {
            helpRow.appendChild(this.buildVendorLink('Get →', target));
        }
        if (env.docs_url !== undefined) {
            helpRow.appendChild(this.buildVendorLink('Docs ↗', env.docs_url));
        }
        if (env.format_hint !== undefined && env.format_hint.length > 0) {
            helpRow.appendChild(
                el('span', { className: 'deploy-row-hint deploy-row-hint--dim' }, [
                    `Format: ${env.format_hint}`,
                ])
            );
        }
        wrap.appendChild(helpRow);

        return wrap;
    }

    private buildSkipToggle(initial: boolean): HTMLElement {
        const wrap = el('div', { className: 'deploy-row deploy-row--skip' });
        const checkbox = el('input', { type: 'checkbox', className: 'deploy-skip-toggle' });
        checkbox.checked = initial;
        this.skipToggle = checkbox;
        wrap.appendChild(
            el('label', { className: 'deploy-skip-label' }, [
                checkbox,
                ' Skip deployment config for now (fill in before deploy)',
            ])
        );
        return wrap;
    }

    /**
     * Phase 2b — "Save to key register" tickbox. When checked, the caller
     * persists the collected secrets to the OS keychain after the project is
     * created, so future runs of this project pick them up without re-entry.
     */
    private buildKeyRegisterToggle(): HTMLElement {
        const wrap = el('div', { className: 'deploy-row deploy-row--key-register' });
        const checkbox = el('input', {
            type: 'checkbox',
            className: 'deploy-key-register-toggle',
            dataset: { deployKeyRegister: '' },
        });
        this.keyRegisterToggle = checkbox;
        wrap.appendChild(
            el('label', { className: 'deploy-key-register-label' }, [
                checkbox,
                ' Save these secrets to the key register (OS keychain) for future runs',
            ])
        );
        wrap.appendChild(
            el('p', { className: 'deploy-row-hint' }, [
                'Stored locally in your OS keychain — never written to the repo or sent anywhere.',
            ])
        );
        return wrap;
    }

    private buildVendorLink(label: string, url: string): HTMLElement {
        const btn = el('button', { type: 'button', className: 'deploy-link-btn' }, [label]);
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            void this.bridge.openVendorUrl(url);
        });
        return btn;
    }

    // ── Mutations ──────────────────────────────────

    private setTokenBadge(state: 'saved' | 'empty' | 'error'): void {
        const badge = this.vercelTokenBadge;
        if (badge === null) return;
        badge.className = 'deploy-token-badge';
        if (state === 'saved') {
            badge.classList.add('deploy-token-badge--saved');
            badge.textContent = '● Saved';
        } else if (state === 'empty') {
            badge.classList.add('deploy-token-badge--empty');
            badge.textContent = '○ Not saved';
        } else {
            badge.classList.add('deploy-token-badge--error');
            badge.textContent = '⚠ Error';
        }
    }

    private async runTest(
        env: BundleDeploymentEnvVar,
        input: HTMLInputElement,
        status: HTMLElement,
        btn: HTMLButtonElement
    ): Promise<void> {
        const value = input.value.trim();
        if (value.length === 0) {
            status.className = `deploy-status ${statusClass('invalid_format')}`;
            status.textContent = 'enter a value first';
            return;
        }
        const provider = providerForEnvKey(env);
        if (provider === null) {
            // No vendor probe known for this var — fall back to format-regex.
            const regex = compileRegexSafely(env.format_regex);
            const ok = regex === null || regex.test(value);
            status.className = `deploy-status ${ok ? 'deploy-status--valid' : 'deploy-status--bad'}`;
            status.textContent = ok ? '✓ Format ok' : '✗ Bad format';
            return;
        }
        btn.disabled = true;
        status.className = 'deploy-status deploy-status--idle';
        status.textContent = 'Testing…';
        try {
            const res = await this.bridge.testSecret(provider, value);
            if (!res.success || res.result === undefined) {
                status.className = `deploy-status ${statusClass('unknown')}`;
                status.textContent = TEST_CODE_LABELS.unknown;
                return;
            }
            const code = res.result.code;
            const baseLabel = TEST_CODE_LABELS[code];
            status.className = `deploy-status ${statusClass(code)}`;
            status.textContent =
                code === 'valid' && res.result.identity !== undefined
                    ? `${baseLabel} · ${res.result.identity}`
                    : baseLabel;
        } finally {
            btn.disabled = false;
        }
    }

    private passesFormat(env: BundleDeploymentEnvVar, value: string): boolean {
        const regex = compileRegexSafely(env.format_regex);
        return regex === null || regex.test(value);
    }

    private maybeCollapseSetup(wrap: HTMLElement): void {
        if (this.setupSteps.every((s) => s.checked)) {
            wrap.removeAttribute('open');
        }
    }
}

// ── Provider routing ─────────────────────────────────

/**
 * Map a bundle env-var entry to the testSecret provider id (D-N).
 * Returns null when no vendor probe is registered — caller falls back
 * to a format-regex check so the [Test] button still gives feedback.
 */
function providerForEnvKey(env: BundleDeploymentEnvVar): string | null {
    const key = env.key;
    if (key === 'DATABASE_URL') return 'neon';
    if (key === 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY') return 'clerk-publishable';
    if (key === 'CLERK_SECRET_KEY') return 'clerk-secret';
    if (key.startsWith('STRIPE_')) return 'stripe';
    return null;
}

// ── Production bridge ────────────────────────────────

/**
 * Default bridge that hits the IPC channels exposed by the
 * `command-center-preload.ts` contextBridge. Renderer modules should
 * pass this when constructing the section in production; tests inject
 * a deterministic stub.
 */
export function defaultDeploymentConfigBridge(): DeploymentConfigBridge {
    const w = window as unknown as {
        kageOps: {
            deploymentConfig: DeploymentConfigBridge;
        };
    };
    return w.kageOps.deploymentConfig;
}
