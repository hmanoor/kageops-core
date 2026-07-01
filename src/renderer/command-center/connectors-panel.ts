/**
 * KageOps Connectors Config Panel
 * Slack · Discord · MS Teams (free)
 * WhatsApp · Google Drive (Team plan and above — F-373 / F-374)
 *
 * Each connector declares its own field schema, so panels with multi-field
 * setups (Twilio creds, OAuth tokens) render cleanly alongside the simple
 * webhook-only cards.
 */

import type { ConnectorConfig } from '../../connectors/types';

export interface ConnectorPanelCallbacks {
    getConfig(name: string): Promise<ConnectorConfig>;
    saveConfig(name: string, config: ConnectorConfig): Promise<{ success: boolean; error?: string }>;
    testConnector(name: string, config: ConnectorConfig): Promise<{ ok: boolean; error?: string }>;
    // F-374b — Google Drive OAuth. Optional so non-Electron preview contexts
    // (tests, mocks) can render the panel without wiring the gdrive bridge.
    gdriveStatus?(): Promise<{ configured: boolean; signedIn: boolean; email: string | null }>;
    gdriveSignIn?(): Promise<{ ok: boolean; email?: string; error?: string }>;
    gdriveSignOut?(): Promise<{ ok: boolean }>;
    gdriveListFolders?(): Promise<{ ok: boolean; folders?: ReadonlyArray<{ id: string; name: string }>; error?: string }>;
}

type FieldKey =
    | 'webhookUrl'
    | 'twilioAccountSid'
    | 'twilioAuthToken'
    | 'twilioFromNumber'
    | 'whatsappToNumber'
    | 'googleAccessToken'
    | 'googleFolderId';

interface FieldDef {
    readonly key: FieldKey;
    readonly label: string;
    readonly type: 'text' | 'url' | 'password';
    readonly placeholder: string;
}

type PlanTier = 'free' | 'team' | 'enterprise';

interface ConnectorDef {
    readonly name: string;
    readonly label: string;
    /** Inline SVG markup for the connector glyph. Caller owns the outer
     *  <span class="cn-icon"> so the SVG should be just the root <svg>. */
    readonly icon: string;
    readonly helpText: string;
    readonly docsUrl: string;
    readonly fields: ReadonlyArray<FieldDef>;
    readonly requiredPlan: PlanTier;
}

// ── Brand glyphs ─────────────────────────────────────
// Hand-traced SVGs that match each vendor's published mark closely enough
// to be unambiguous, without including the literal logo files (which are
// trademarked). Sized to a 24x24 viewbox so all 5 cards line up.

const ICON_SLACK = `
<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M4.5 14.5a1.5 1.5 0 1 1-1.5-1.5h1.5v1.5Zm.75 0a1.5 1.5 0 0 1 3 0v3.75a1.5 1.5 0 1 1-3 0v-3.75Z" fill="#E01E5A"/>
  <path d="M9.5 4.5a1.5 1.5 0 1 1 1.5-1.5v1.5H9.5Zm0 .75a1.5 1.5 0 0 1 0 3H5.75a1.5 1.5 0 1 1 0-3H9.5Z" fill="#36C5F0"/>
  <path d="M19.5 9.5a1.5 1.5 0 1 1 1.5 1.5h-1.5V9.5Zm-.75 0a1.5 1.5 0 0 1-3 0V5.75a1.5 1.5 0 1 1 3 0V9.5Z" fill="#2EB67D"/>
  <path d="M14.5 19.5a1.5 1.5 0 1 1-1.5 1.5v-1.5h1.5Zm0-.75a1.5 1.5 0 0 1 0-3h3.75a1.5 1.5 0 1 1 0 3H14.5Z" fill="#ECB22E"/>
</svg>`;

const ICON_DISCORD = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path fill="#5865F2" d="M19.27 5.33A17.66 17.66 0 0 0 15.05 4l-.21.42a16 16 0 0 0-5.68 0L8.95 4a17.66 17.66 0 0 0-4.22 1.33C2.07 9.32 1.34 13.21 1.7 17.05a17.79 17.79 0 0 0 5.4 2.73l.43-.6a11.5 11.5 0 0 1-1.81-.88l.45-.32a12.7 12.7 0 0 0 11.66 0l.45.32c-.57.34-1.18.64-1.81.88l.43.6a17.79 17.79 0 0 0 5.4-2.73c.43-4.43-.7-8.29-2.03-11.72ZM8.52 14.95c-1.06 0-1.93-.99-1.93-2.2 0-1.22.85-2.2 1.93-2.2 1.08 0 1.95.98 1.93 2.2 0 1.21-.85 2.2-1.93 2.2Zm7 0c-1.06 0-1.93-.99-1.93-2.2 0-1.22.85-2.2 1.93-2.2 1.08 0 1.95.98 1.93 2.2 0 1.21-.85 2.2-1.93 2.2Z"/>
</svg>`;

const ICON_MS_TEAMS = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path fill="#4B53BC" d="M21.3 9h-6.6a1.4 1.4 0 0 0-1.4 1.4v7.2a1.4 1.4 0 0 0 1.4 1.4h4.4l3 2.6V10.4A1.4 1.4 0 0 0 21.3 9Z"/>
  <circle cx="17.5" cy="6.2" r="2.2" fill="#4B53BC"/>
  <path fill="#7B83EB" d="M11.4 5H2.6A1.6 1.6 0 0 0 1 6.6v10.8A1.6 1.6 0 0 0 2.6 19h8.8a1.6 1.6 0 0 0 1.6-1.6V6.6A1.6 1.6 0 0 0 11.4 5Z"/>
  <path fill="#fff" d="M9.4 9.3H7.7v6.3H6.3V9.3H4.6V8h4.8v1.3Z"/>
</svg>`;

const ICON_WHATSAPP = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path fill="#25D366" d="M20.5 3.5A11.7 11.7 0 0 0 3.6 19.3L2 24l4.8-1.6a11.7 11.7 0 0 0 13.7-18.9Zm-8.5 18a9.7 9.7 0 0 1-4.9-1.3l-.35-.21-2.85.94.96-2.78-.23-.36A9.7 9.7 0 1 1 12 21.5Z"/>
  <path fill="#fff" d="M17.18 14.42c-.29-.14-1.72-.85-1.99-.95-.27-.1-.46-.14-.66.14-.19.29-.76.95-.93 1.14-.17.19-.34.22-.63.07-.29-.14-1.23-.45-2.35-1.45-.87-.78-1.46-1.74-1.63-2.03-.17-.29-.02-.45.13-.6.13-.13.29-.34.43-.51.14-.17.19-.29.29-.48.1-.19.05-.36-.02-.51-.07-.14-.66-1.6-.9-2.18-.24-.57-.48-.49-.66-.5h-.56c-.2 0-.51.07-.78.36-.27.29-1.02 1-1.02 2.44 0 1.44 1.05 2.83 1.2 3.03.14.19 2.07 3.16 5 4.43.7.3 1.25.48 1.67.62.7.22 1.34.19 1.84.12.56-.08 1.72-.7 1.97-1.38.24-.68.24-1.26.17-1.38-.07-.12-.26-.19-.55-.34Z"/>
</svg>`;

const ICON_GOOGLE_DRIVE = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path fill="#0066DA" d="M3.3 17.6 4.65 20a1.85 1.85 0 0 0 1.55 1l3-5.2H3.05a1.85 1.85 0 0 0 .25 1.8Z"/>
  <path fill="#00AC47" d="M12 8.8 9 3.6a1.85 1.85 0 0 0-1.55 1L1.9 14.2a1.85 1.85 0 0 0-.25 1.8H9l3-7.2Z"/>
  <path fill="#EA4335" d="M17.8 21a1.85 1.85 0 0 0 1.55-1l.55-.95L22.4 15a1.85 1.85 0 0 0-.25-1.8l-5.55 9.6.3.2c.3.2.6 0 .9 0Z"/>
  <path fill="#00832D" d="M12 8.8 15 3.6a1.85 1.85 0 0 0-.9-.25H9.9a1.85 1.85 0 0 0-.9.25l3 5.2Z"/>
  <path fill="#2684FC" d="M15 15.2H9l-3 5.2a1.85 1.85 0 0 0 .9.25h10.2a1.85 1.85 0 0 0 .9-.25l-3-5.2Z"/>
  <path fill="#FFBA00" d="m17.8 9.2-3-5.2-3 5.2L15 15.2h6.05a1.85 1.85 0 0 0-.25-1.8L17.8 9.2Z"/>
</svg>`;

const CONNECTORS: ReadonlyArray<ConnectorDef> = [
    {
        name: 'slack',
        label: 'Slack',
        icon: ICON_SLACK,
        helpText: 'Create an Incoming Webhook in your Slack workspace. KageOps sends Block Kit messages with a "View in KageOps" button.',
        docsUrl: 'https://api.slack.com/messaging/webhooks',
        requiredPlan: 'free',
        fields: [
            { key: 'webhookUrl', label: 'Webhook URL', type: 'url',
              placeholder: 'https://hooks.slack.com/services/T.../B.../...' },
        ],
    },
    {
        name: 'discord',
        label: 'Discord',
        icon: ICON_DISCORD,
        helpText: 'In Discord: Server Settings → Integrations → Webhooks → New Webhook. Messages appear as rich embeds.',
        docsUrl: 'https://support.discord.com/hc/en-us/articles/228383668',
        requiredPlan: 'free',
        fields: [
            { key: 'webhookUrl', label: 'Webhook URL', type: 'url',
              placeholder: 'https://discord.com/api/webhooks/...' },
        ],
    },
    {
        name: 'ms-teams',
        label: 'Microsoft Teams',
        icon: ICON_MS_TEAMS,
        helpText: 'In Teams: channel → ... → Connectors → Incoming Webhook. Messages use Adaptive Cards.',
        docsUrl: 'https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
        requiredPlan: 'free',
        fields: [
            { key: 'webhookUrl', label: 'Webhook URL', type: 'url',
              placeholder: 'https://xxx.webhook.office.com/webhookb2/...' },
        ],
    },
    {
        name: 'whatsapp',
        label: 'WhatsApp',
        icon: ICON_WHATSAPP,
        helpText: 'Send approvals and phase updates to a WhatsApp number via Twilio. Paste your Twilio credentials and the from/to numbers (in E.164 format, e.g. +14155551234).',
        docsUrl: 'https://www.twilio.com/docs/whatsapp/quickstart',
        requiredPlan: 'team',
        fields: [
            { key: 'twilioAccountSid',  label: 'Twilio Account SID', type: 'text',
              placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
            { key: 'twilioAuthToken',   label: 'Twilio Auth Token',  type: 'password',
              placeholder: '••••••••••••••••••••••••••••••••' },
            { key: 'twilioFromNumber',  label: 'From (Twilio WhatsApp sender)', type: 'text',
              placeholder: '+14155238886' },
            { key: 'whatsappToNumber',  label: 'To (your WhatsApp number)', type: 'text',
              placeholder: '+14155551234' },
        ],
    },
    {
        name: 'google-drive',
        label: 'Google Drive',
        icon: ICON_GOOGLE_DRIVE,
        helpText: 'Mirror approval and project artifacts to a Google Drive folder. Sign in with Google below — no token-pasting required.',
        docsUrl: 'https://developers.google.com/drive/api/guides/about-auth',
        requiredPlan: 'team',
        // Field list kept (googleFolderId is rendered by the custom picker
        // block) so collectFieldValues continues to round-trip the folder ID
        // through saveConnectorConfig.
        fields: [
            { key: 'googleFolderId', label: 'Drive Folder ID', type: 'text',
              placeholder: '1AbCd...XYZ' },
        ],
    },
];

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function planBadge(tier: PlanTier): string {
    if (tier === 'free') return '';
    const label = tier === 'team' ? 'Team plan' : 'Enterprise';
    return `<span class="cn-plan-badge" title="Requires ${esc(label)} or higher">${esc(label)}</span>`;
}

function renderField(connectorName: string, f: FieldDef): string {
    return `
        <label class="cn-label">${esc(f.label)}</label>
        <input type="${f.type}" class="cn-field-input"
            data-connector="${esc(connectorName)}"
            data-field="${esc(f.key)}"
            placeholder="${esc(f.placeholder)}"
            autocomplete="off" spellcheck="false" />
    `;
}

function renderGDriveOAuthBlock(): string {
    return `
        <div class="cn-gdrive-oauth" data-role="gdrive-oauth">
            <div class="cn-gdrive-status" data-role="gdrive-account">Checking Google account…</div>
            <div class="cn-button-row">
                <button class="btn-sm btn-primary" data-action="gdrive-signin">Sign in with Google</button>
                <button class="btn-sm cn-hidden" data-action="gdrive-signout">Sign out</button>
            </div>
        </div>`;
}

function renderGDriveFolderPicker(): string {
    return `
        <label class="cn-label">Target folder</label>
        <div class="cn-button-row" data-role="gdrive-folder-row">
            <select class="cn-field-input cn-hidden" data-role="gdrive-folder-select"></select>
            <input type="text" class="cn-field-input"
                data-connector="google-drive" data-field="googleFolderId"
                placeholder="Sign in, then pick a folder or paste its ID"
                autocomplete="off" spellcheck="false" />
            <button class="btn-sm" data-action="gdrive-load-folders" disabled>Load folders</button>
        </div>`;
}

function renderCard(def: ConnectorDef): string {
    const isGDrive = def.name === 'google-drive';
    const fieldsHtml = isGDrive
        ? `${renderGDriveOAuthBlock()}${renderGDriveFolderPicker()}`
        : def.fields.map(f => renderField(def.name, f)).join('');
    return `
    <div class="cn-card" data-connector="${esc(def.name)}">
        <div class="cn-card-header">
            <span class="cn-icon">${def.icon}</span>
            <div class="cn-card-title-group">
                <span class="cn-card-title">${esc(def.label)} ${planBadge(def.requiredPlan)}</span>
                <span class="cn-card-status" id="cn-status-${esc(def.name)}">Loading…</span>
            </div>
            <label class="cn-toggle" title="Enable or disable this connector">
                <input type="checkbox" class="cn-enabled-chk" data-connector="${esc(def.name)}" />
                <span class="cn-toggle-track"></span>
            </label>
        </div>
        <p class="cn-help">${esc(def.helpText)}
            <a class="cn-docs-link" href="${esc(def.docsUrl)}" target="_blank" rel="noopener">Setup guide ↗</a>
        </p>
        <div class="cn-fields">
            ${fieldsHtml}
            <div class="cn-button-row">
                <button class="btn-sm" data-connector="${esc(def.name)}" data-action="test"
                    title="Send a test message to verify the connection">Test</button>
                <button class="btn-sm btn-primary" data-connector="${esc(def.name)}" data-action="save"
                    title="Save this configuration">Save</button>
            </div>
            <div class="cn-feedback cn-hidden" id="cn-feedback-${esc(def.name)}"></div>
        </div>
    </div>`;
}

function collectFieldValues(card: HTMLElement, def: ConnectorDef): Partial<ConnectorConfig> {
    const out: Record<string, string> = {};
    for (const f of def.fields) {
        const input = card.querySelector<HTMLInputElement>(
            `.cn-field-input[data-field="${f.key}"]`,
        );
        const v = input?.value.trim() ?? '';
        if (v !== '') out[f.key] = v;
    }
    return out as Partial<ConnectorConfig>;
}

function hasAnyValue(values: Partial<ConnectorConfig>, def: ConnectorDef): boolean {
    return def.fields.some(f => {
        const v = (values as Record<string, unknown>)[f.key];
        return typeof v === 'string' && v.length > 0;
    });
}

export function renderConnectorsPanel(container: HTMLElement, callbacks: ConnectorPanelCallbacks): void {
    container.innerHTML = `
        <div class="cn-panel">
            <div class="cn-intro">
                <div class="cn-intro-title">Outbound Connectors</div>
                <div class="cn-intro-body">Send KageOps events — approvals, phase changes, task claims — to your team's communication tools. WhatsApp and Google Drive require Team plan or higher.</div>
            </div>
            ${CONNECTORS.map(renderCard).join('')}
        </div>`;

    CONNECTORS.forEach(def => {
        const card = container.querySelector(`[data-connector="${def.name}"]`) as HTMLElement;
        const enabledChk = card.querySelector<HTMLInputElement>('.cn-enabled-chk')!;
        const statusEl = container.querySelector<HTMLElement>(`#cn-status-${def.name}`)!;
        const feedbackEl = container.querySelector<HTMLElement>(`#cn-feedback-${def.name}`)!;

        function showFeedback(msg: string, isError: boolean): void {
            feedbackEl.textContent = msg;
            feedbackEl.className = `cn-feedback ${isError ? 'cn-error' : 'cn-ok'}`;
        }

        function paintStatus(enabled: boolean, hasValues: boolean): void {
            if (!enabled) {
                statusEl.textContent = 'Disabled';
                statusEl.className = 'cn-card-status cn-status-off';
            } else if (!hasValues) {
                statusEl.textContent = 'Not configured';
                statusEl.className = 'cn-card-status cn-status-off';
            } else {
                statusEl.textContent = 'Enabled';
                statusEl.className = 'cn-card-status cn-status-on';
            }
        }

        function buildConfig(enabled: boolean): ConnectorConfig {
            const values = collectFieldValues(card, def);
            return { ...values, enabled } as ConnectorConfig;
        }

        void callbacks.getConfig(def.name).then(cfg => {
            for (const f of def.fields) {
                const input = card.querySelector<HTMLInputElement>(
                    `.cn-field-input[data-field="${f.key}"]`,
                );
                if (input !== null) {
                    const v = (cfg as unknown as Record<string, unknown>)[f.key];
                    input.value = typeof v === 'string' ? v : '';
                }
            }
            enabledChk.checked = cfg.enabled;
            paintStatus(cfg.enabled, hasAnyValue(cfg, def));
        });

        enabledChk.addEventListener('change', () => {
            const cfg = buildConfig(enabledChk.checked);
            void callbacks.saveConfig(def.name, cfg).then(r => {
                paintStatus(enabledChk.checked, hasAnyValue(cfg, def));
                if (!r.success) showFeedback(r.error ?? 'Save failed', true);
            });
        });

        card.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener('click', () => {
            const cfg = buildConfig(enabledChk.checked);
            void callbacks.saveConfig(def.name, cfg).then(r => {
                if (r.success) {
                    showFeedback('Saved.', false);
                    paintStatus(enabledChk.checked, hasAnyValue(cfg, def));
                } else {
                    showFeedback(r.error ?? 'Save failed', true);
                }
            });
        });

        card.querySelector<HTMLButtonElement>('[data-action="test"]')?.addEventListener('click', () => {
            const cfg = buildConfig(true);
            if (!hasAnyValue(cfg, def)) {
                showFeedback('Fill in the connector fields first.', true);
                return;
            }
            const btn = card.querySelector<HTMLButtonElement>('[data-action="test"]')!;
            btn.disabled = true;
            btn.textContent = 'Sending…';
            void callbacks.testConnector(def.name, cfg).then(r => {
                btn.disabled = false;
                btn.textContent = 'Test';
                showFeedback(r.ok ? 'Test message sent successfully.' : (r.error ?? 'Test failed'), !r.ok);
            });
        });

        if (def.name === 'google-drive') {
            wireGoogleDriveCard(card, callbacks, showFeedback);
        }
    });
}

// ── Google Drive OAuth panel wiring ─────────────────
function wireGoogleDriveCard(
    card: HTMLElement,
    callbacks: ConnectorPanelCallbacks,
    showFeedback: (msg: string, isError: boolean) => void,
): void {
    const accountEl = card.querySelector<HTMLElement>('[data-role="gdrive-account"]')!;
    const signInBtn = card.querySelector<HTMLButtonElement>('[data-action="gdrive-signin"]')!;
    const signOutBtn = card.querySelector<HTMLButtonElement>('[data-action="gdrive-signout"]')!;
    const loadFoldersBtn = card.querySelector<HTMLButtonElement>('[data-action="gdrive-load-folders"]')!;
    const folderSelect = card.querySelector<HTMLSelectElement>('[data-role="gdrive-folder-select"]')!;
    const folderInput = card.querySelector<HTMLInputElement>(
        '.cn-field-input[data-field="googleFolderId"]',
    )!;

    function paintStatus(status: { configured: boolean; signedIn: boolean; email: string | null }): void {
        if (!status.configured) {
            accountEl.textContent =
                'Google Sign-In not configured by this build. Use the docs link above to set up an OAuth client, or paste a folder ID with a manual token.';
            signInBtn.disabled = true;
            signInBtn.classList.add('cn-hidden');
            signOutBtn.classList.add('cn-hidden');
            loadFoldersBtn.disabled = true;
            return;
        }
        if (status.signedIn) {
            accountEl.textContent = status.email !== null && status.email !== ''
                ? `Signed in as ${status.email}`
                : 'Signed in to Google Drive.';
            signInBtn.classList.add('cn-hidden');
            signOutBtn.classList.remove('cn-hidden');
            loadFoldersBtn.disabled = false;
        } else {
            accountEl.textContent = 'Not signed in. Click below to grant Drive access in your browser.';
            signInBtn.classList.remove('cn-hidden');
            signInBtn.disabled = false;
            signOutBtn.classList.add('cn-hidden');
            loadFoldersBtn.disabled = true;
        }
    }

    function refreshStatus(): void {
        if (callbacks.gdriveStatus === undefined) {
            paintStatus({ configured: false, signedIn: false, email: null });
            return;
        }
        void callbacks.gdriveStatus().then(paintStatus);
    }

    refreshStatus();

    signInBtn.addEventListener('click', () => {
        if (callbacks.gdriveSignIn === undefined) return;
        signInBtn.disabled = true;
        const originalText = signInBtn.textContent ?? 'Sign in with Google';
        signInBtn.textContent = 'Waiting for browser…';
        void callbacks.gdriveSignIn().then((r) => {
            signInBtn.disabled = false;
            signInBtn.textContent = originalText;
            if (!r.ok) {
                showFeedback(r.error ?? 'Sign-in failed', true);
                return;
            }
            showFeedback(
                r.email !== undefined && r.email !== '' ? `Signed in as ${r.email}.` : 'Signed in.',
                false,
            );
            refreshStatus();
        });
    });

    signOutBtn.addEventListener('click', () => {
        if (callbacks.gdriveSignOut === undefined) return;
        signOutBtn.disabled = true;
        void callbacks.gdriveSignOut().then(() => {
            signOutBtn.disabled = false;
            showFeedback('Signed out of Google Drive.', false);
            folderSelect.classList.add('cn-hidden');
            folderSelect.innerHTML = '';
            refreshStatus();
        });
    });

    loadFoldersBtn.addEventListener('click', () => {
        if (callbacks.gdriveListFolders === undefined) return;
        loadFoldersBtn.disabled = true;
        const originalText = loadFoldersBtn.textContent ?? 'Load folders';
        loadFoldersBtn.textContent = 'Loading…';
        void callbacks.gdriveListFolders().then((r) => {
            loadFoldersBtn.disabled = false;
            loadFoldersBtn.textContent = originalText;
            if (!r.ok || r.folders === undefined) {
                showFeedback(r.error ?? 'Could not list folders', true);
                return;
            }
            folderSelect.innerHTML =
                '<option value="">Pick a folder…</option>' +
                r.folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
            folderSelect.classList.remove('cn-hidden');
            folderSelect.value = folderInput.value;
            showFeedback(`Loaded ${r.folders.length} folder${r.folders.length === 1 ? '' : 's'}.`, false);
        });
    });

    folderSelect.addEventListener('change', () => {
        if (folderSelect.value !== '') folderInput.value = folderSelect.value;
    });
}
