/**
 * KageOps Command Center Preload Script
 *
 * Exposes the kageOps API to the Command Center renderer process.
 */

import { contextBridge, ipcRenderer, clipboard } from 'electron';

contextBridge.exposeInMainWorld('kageOps', {
    // ── Clipboard ────────────────────────────────
    // Routed through the preload's `clipboard` module rather than
    // navigator.clipboard.writeText, which is silently rejected in
    // the Command Center renderer (clipboard permission missing).
    writeTextToClipboard: (text: string): boolean => {
        try {
            clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    },

    // ── Auth — current signed-in user + sign-out ─────
    getCurrentUser: (): Promise<{
        userId: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        plan: string;
    } | null> =>
        ipcRenderer.invoke('auth:get-current-user'),
    signOut: (): Promise<void> =>
        ipcRenderer.invoke('auth:sign-out'),
    // Re-open the Plan window from Command Center "Manage plan" menu.
    // Returns { ok: true } on success, or { ok: false, error } if the
    // user isn't signed in or the profile fetch failed.
    reopenPlanWindow: (): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke('plan:reopen'),

    // ── Projects ─────────────────────────────────
    getProjects: () => ipcRenderer.invoke('command-center:get-projects'),
    // KB needs completed projects too so users can browse historical work.
    getKnowledgeBaseProjects: () => ipcRenderer.invoke('command-center:get-knowledge-base-projects'),
    startProject: (name: string, description: string) =>
        ipcRenderer.invoke('command-center:start-project', name, description),
    setTitleBarOverlay: (palette: { color: string; symbolColor: string }) =>
        ipcRenderer.invoke('command-center:set-title-bar-overlay', palette),
    getAgentStreamHistory: (args: { agent: string; taskId?: string | null; limit?: number }) =>
        ipcRenderer.invoke('command-center:get-agent-stream-history', args),
    startProjectAdvanced: (args: {
        name: string;
        description: string;
        trustLevel?: 'low' | 'medium' | 'high';
        enabledPhases?: readonly string[];
        projectType?: string;
        techStack?: string;
        goal?: string;
        budgetUsd?: number;
        // #165 stage 2 — operator-picked per-phase task allowlist. Omit
        // or pass null to keep legacy "LLM picks freely" behaviour.
        phaseTaskSelections?: Readonly<Record<string, readonly string[]>> | null;
        // Pillar 2.2 PR-E — operator-picked bundle name from the
        // Project Type dropdown. Skips Scout's keyword matcher when set.
        selectedBundle?: string;
    }) => ipcRenderer.invoke('command-center:start-project-advanced', args),

    // ── Agents ─────────��─────────────────────────
    getAgents: () => ipcRenderer.invoke('command-center:get-agents'),

    // ── Approvals ────────────────────────────────
    getApprovalQueue: () => ipcRenderer.invoke('command-center:get-approvals'),
    getApprovalDetails: (projectId: string) =>
        ipcRenderer.invoke('command-center:get-approval-details', projectId),
    getApprovalHistory: () => ipcRenderer.invoke('command-center:get-approval-history'),
    approveGate: (projectId: string) =>
        ipcRenderer.invoke('command-center:approve-gate', projectId),
    denyGate: (projectId: string) =>
        ipcRenderer.invoke('command-center:deny-gate', projectId),

    // ── Speciality Matrix ─────────────────────────
    getMatrix: () => ipcRenderer.invoke('command-center:get-matrix'),

    // ── Sensei Chat ──────────────────────────────
    // Backwards-compat: old call form `sendToSensei(message)` keeps working
    // because main's handler accepts a bare string. PR B of F-302 added
    // `sendToSenseiWithContext` for the project-scoped + attributed shape.
    sendToSensei: (message: string) =>
        ipcRenderer.invoke('command-center:sensei-message', { message }),
    sendToSenseiWithContext: (args: {
        readonly message: string;
        readonly projectId?: string;
        readonly authorUserId?: string;
        readonly authorName?: string;
        readonly authorRole?: 'owner' | 'reviewer' | 'observer';
    }) =>
        ipcRenderer.invoke('command-center:sensei-message', args),

    // ── API Key Management ──────────────────────
    getApiKeyStatus: () =>
        ipcRenderer.invoke('command-center:get-api-key-status'),
    setApiKey: (provider: string, key: string) =>
        ipcRenderer.invoke('command-center:set-api-key', provider, key),
    deleteApiKey: (provider: string) =>
        ipcRenderer.invoke('command-center:delete-api-key', provider),

    // ── Cost Tracker (project budgets) ──────────
    getCosts: () => ipcRenderer.invoke('command-center:get-costs'),

    // ── Operational Cost Intelligence (v0.7) ────
    // Returns OperationalCostSummary with today/week/month totals + breakdowns
    getOperationalCosts: (windowDays?: number) =>
        ipcRenderer.invoke('command-center:get-operational-costs', windowDays ?? 30),

    // ── Run Budgets (B-449) — per-project cap + live spend ──
    getRunBudgets: () =>
        ipcRenderer.invoke('command-center:get-run-budgets'),
    setProjectBudget: (projectId: string, capUsd: number) =>
        ipcRenderer.invoke('command-center:set-project-budget', { projectId, capUsd }),

    // ── Code Graph Status (v0.8) ────────────────
    getGraphStatus: (repoPath: string) =>
        ipcRenderer.invoke('command-center:get-graph-status', repoPath),
    getGraphStatuses: () =>
        ipcRenderer.invoke('command-center:get-graph-statuses'),
    getGraphifyGraphs: () =>
        ipcRenderer.invoke('command-center:get-graphify-graphs'),
    runGraphify: (projectId: string, repoPath: string) =>
        ipcRenderer.invoke('command-center:run-graphify', { projectId, repoPath }),
    onGraphifyProgress: (cb: (event: unknown) => void) => {
        const handler = (_: Electron.IpcRendererEvent, data: unknown) => cb(data);
        ipcRenderer.on('graphify-progress', handler);
        return () => ipcRenderer.off('graphify-progress', handler);
    },
    readGraphHtml: (filePath: string) =>
        ipcRenderer.invoke('command-center:read-graph-html', filePath),
    openExternal: (url: string) =>
        ipcRenderer.invoke('command-center:open-external', url),

    // ── GitHub Integration (v0.9) ───────────────
    setGitHubToken: (token: string) =>
        ipcRenderer.invoke('settings:set-github-token', token),
    getGitHubStatus: () =>
        ipcRenderer.invoke('settings:get-github-status'),
    setProjectGitHub: (projectId: string, owner: string, repo: string) =>
        ipcRenderer.invoke('command-center:set-project-github', projectId, owner, repo),

    // ── Build Status ────────────────────────────
    getBuilds: () => ipcRenderer.invoke('command-center:get-builds'),

    // ── Notifications ───────────────────────────
    getNotifications: () => ipcRenderer.invoke('command-center:get-notifications'),

    // ── Model Config (v1.0) ──────────────────────
    getAgentModelConfigs: () =>
        ipcRenderer.invoke('command-center:get-agent-model-configs'),
    setAgentModel: (agentName: string, model: string, provider: string, fallbackModels: string[]) =>
        ipcRenderer.invoke('command-center:set-agent-model', { agentName, model, provider, fallbackModels }),
    testAgentModel: (agentName: string, model: string, provider: string) =>
        ipcRenderer.invoke('command-center:test-agent-model', { agentName, model, provider }),

    // ── Preset switcher (v1.6) ───────────────────
    listPresets: () =>
        ipcRenderer.invoke('command-center:list-presets'),
    setActivePreset: (preset: string | null) =>
        ipcRenderer.invoke('command-center:set-active-preset', { preset }),
    createPreset: (
        name: string,
        agents: Record<string, { model: string; provider: string; fallbackModels?: readonly string[] }>,
        overwrite?: boolean,
    ) => ipcRenderer.invoke('command-center:create-preset', { name, agents, overwrite }),
    deletePreset: (name: string) =>
        ipcRenderer.invoke('command-center:delete-preset', { name }),
    getPreset: (name: string) =>
        ipcRenderer.invoke('command-center:get-preset', { name }),

    // ── Design provider switcher (v2.5) ──────────
    listDesignProviders: () =>
        ipcRenderer.invoke('command-center:list-design-providers'),
    setActiveDesignProvider: (providerId: string) =>
        ipcRenderer.invoke('command-center:set-active-design-provider', { providerId }),

    // ── System Status (v1.0) ─────────────────────
    getSystemStatus: () =>
        ipcRenderer.invoke('command-center:get-system-status'),

    // ── Deployments (v1.1) ───────────────────────
    getDeployments: () =>
        ipcRenderer.invoke('deployments:get'),
    saveDeployment: (target: unknown) =>
        ipcRenderer.invoke('deployments:save', target),
    deleteDeployment: (id: string) =>
        ipcRenderer.invoke('deployments:delete', { id }),

    // ── Bundle discovery (Pillar 2.2 PR-B.2) ─────
    listBundles: () =>
        ipcRenderer.invoke('bundles:list'),

    // ── Deployment Config (Pillar 2.2 PR-B.1) ────
    deploymentConfig: {
        get: (projectId: string) =>
            ipcRenderer.invoke('deployment-config:get', { projectId }),
        save: (projectId: string, values: Record<string, string>) =>
            ipcRenderer.invoke('deployment-config:save', { projectId, values }),
        clear: (projectId: string) =>
            ipcRenderer.invoke('deployment-config:clear', { projectId }),
        has: (projectId: string) =>
            ipcRenderer.invoke('deployment-config:has', { projectId }),
        testSecret: (provider: string, value: string) =>
            ipcRenderer.invoke('deployment-config:test-secret', { provider, value }),
        getVercelTokenStatus: () =>
            ipcRenderer.invoke('deployment-config:get-vercel-token-status'),
        saveVercelToken: (token: string) =>
            ipcRenderer.invoke('deployment-config:save-vercel-token', { token }),
        clearVercelToken: () =>
            ipcRenderer.invoke('deployment-config:clear-vercel-token'),
        openVendorUrl: (url: string) =>
            ipcRenderer.invoke('deployment-config:open-vendor-url', { url }),
        // Phase 2b — OS-keychain "key register" for app secrets.
        saveAppEnv: (projectId: string, values: Record<string, string>) =>
            ipcRenderer.invoke('deployment-config:save-app-env', { projectId, values }),
        appEnvStatus: (projectId: string) =>
            ipcRenderer.invoke('deployment-config:app-env-status', { projectId }),
        clearAppEnv: (projectId: string) =>
            ipcRenderer.invoke('deployment-config:clear-app-env', { projectId }),
    },

    // ── Cloud Burst (Pillar 2.4 / PR-F) ──────────
    // Operator-facing bursting surface. The renderer panel (PR-F.next)
    // calls these from a Cloud Burst tab; DevTools also works:
    //   window.kageOps.cloudBurst.listActive()
    cloudBurst: {
        dispatch: (args: {
            taskId: string;
            projectId: string;
            poolId?: string;
            poolName?: string;
            agentRole: string;
            image: string;
            estimatedCostUsd: number;
            region?: string;
            env?: Record<string, string>;
            secureEnv?: Record<string, string>;
            cpu?: number;
            memoryGb?: number;
        }) => ipcRenderer.invoke('cloud-burst:dispatch', args),
        listActive: () =>
            ipcRenderer.invoke('cloud-burst:list-active'),
        listForProject: (projectId: string) =>
            ipcRenderer.invoke('cloud-burst:list-for-project', { projectId }),
        listRecent: () =>
            ipcRenderer.invoke('cloud-burst:list-recent'),
        stop: (burstId: string) =>
            ipcRenderer.invoke('cloud-burst:stop', { burstId }),
        stopAll: () =>
            ipcRenderer.invoke('cloud-burst:stop-all'),
    },

    // ── Cloud Burst pool CRUD (Pillar 2.4 / PR-G) ─
    // Backs the Settings → Cloud Burst page. Creating the first
    // enabled pool flips the operator from "pool-missing" into "ready
    // to dispatch."
    burstPool: {
        list: () => ipcRenderer.invoke('burst-pool:list'),
        get: (id: string) => ipcRenderer.invoke('burst-pool:get', { id }),
        create: (input: {
            name: string;
            subscriptionId: string;
            resourceGroup: string;
            containerRegistry: string;
            defaultRegion: string;
            budgetCapUsd: number;
            enabled?: boolean;
        }) => ipcRenderer.invoke('burst-pool:create', input),
        update: (
            id: string,
            patch: {
                resourceGroup?: string;
                containerRegistry?: string;
                defaultRegion?: string;
                budgetCapUsd?: number;
                enabled?: boolean;
            }
        ) => ipcRenderer.invoke('burst-pool:update', { id, ...patch }),
        delete: (id: string) => ipcRenderer.invoke('burst-pool:delete', { id }),
    },

    // ── Azure Environments registry (Pillar 2.5 / PR-C) ─
    // Backs the Deployments tab. One environment = one operator Azure
    // (subscription / RG / region [+ tenant + credential ref]) entered
    // once; Cloud Burst pools + deploy targets reference it (D-A).
    azureEnvironment: {
        list: () => ipcRenderer.invoke('azure-env:list'),
        get: (id: string) => ipcRenderer.invoke('azure-env:get', { id }),
        create: (input: {
            label: string;
            subscriptionId: string;
            resourceGroup: string;
            defaultRegion: string;
            tenantId?: string | null;
            credentialRef?: string | null;
        }) => ipcRenderer.invoke('azure-env:create', input),
        update: (
            id: string,
            patch: {
                resourceGroup?: string;
                defaultRegion?: string;
                tenantId?: string | null;
                credentialRef?: string | null;
            }
        ) => ipcRenderer.invoke('azure-env:update', { id, ...patch }),
        delete: (id: string) => ipcRenderer.invoke('azure-env:delete', { id }),
    },

    // ── Deploy targets + runs (Pillar 2.5 / PR-G) ─
    // Backs the Deployments tab's deploy flow. A target = "deploy this
    // project to this Azure environment as this service type"; trigger()
    // fires the orchestrated provision → deploy → live run (manual-only,
    // D-F). suggestServiceType() picks the service type from the project
    // type so the create form pre-selects it (D-E).
    deploy: {
        listTargets: () => ipcRenderer.invoke('deploy-target:list'),
        getTarget: (id: string) => ipcRenderer.invoke('deploy-target:get', { id }),
        createTarget: (input: {
            environmentId: string;
            serviceType: 'app-service' | 'static-web-app';
            appName: string;
            projectId?: string | null;
            config?: { sku?: string; runtime?: string; appServicePlanName?: string };
        }) => ipcRenderer.invoke('deploy-target:create', input),
        deleteTarget: (id: string) => ipcRenderer.invoke('deploy-target:delete', { id }),
        suggestServiceType: (projectId: string) =>
            ipcRenderer.invoke('deploy:suggest-service', { projectId }),
        trigger: (args: { targetId: string; appZipUrl?: string; apiZipUrl?: string }) =>
            ipcRenderer.invoke('deploy:trigger', args),
        teardown: (targetId: string) => ipcRenderer.invoke('deploy:teardown', { targetId }),
        listRecentRuns: () => ipcRenderer.invoke('deploy-run:list-recent'),
        listRunsByTarget: (targetId: string) =>
            ipcRenderer.invoke('deploy-run:list-by-target', { targetId }),
    },

    // ── Unified per-client cost (Pillar 2.5 / PR-I, D-I) ─
    // Rolls Cloud Burst compute + estimated deploy hosting cost up per
    // client; exportClients returns a CSV string for billing.
    cost: {
        getClientRollup: () => ipcRenderer.invoke('cost:get-client-rollup'),
        exportClients: () => ipcRenderer.invoke('cost:export-clients'),
    },

    // ── Agent-image ACR import (Pillar 2.5 / PR-K, D-M) ─
    // One-click server-side copy of the public agent image into the
    // operator's own ACR. PR-L's setup copilot calls this after confirm.
    acr: {
        importAgentImage: (args: {
            subscriptionId: string;
            resourceGroup: string;
            registryName: string;
            tag?: string;
            sourceImage?: string;
        }) => ipcRenderer.invoke('acr:import-agent-image', args),
    },

    // ── Sensei setup copilot (Pillar 2.5 / PR-L, D-N) ─
    // Read-only discovery of setup gaps + the connectivity check. Mutating
    // playbooks (e.g. importAgentImage) reuse their own bridge after confirm.
    setup: {
        listProposals: () => ipcRenderer.invoke('setup:list-proposals'),
        verifyConnectivity: (subscriptionId: string) =>
            ipcRenderer.invoke('setup:verify-connectivity', { subscriptionId }),

        // ── App-credential ledger (MCC-8 / Slice 4) ────
        // Per-project credential ledger: list outstanding proposals, provide a
        // credential (validate-on-entry → persist to deployment_config), and
        // subscribe to Sensei's mid-run `setup.required` pushes.
        listAppProposals: (projectId: string) =>
            ipcRenderer.invoke('setup:list-app-proposals', { projectId }),
        provideCredential: (projectId: string, envKey: string, value: string) =>
            ipcRenderer.invoke('setup:provide-credential', { projectId, envKey, value }),
        // L3 auto-provision (Slice 5): run an `execute` playbook (create the Stripe
        // Price / register the webhook) test-mode and persist the produced value.
        provisionCredential: (projectId: string, playbookId: string) =>
            ipcRenderer.invoke('setup:provision-credential', { projectId, playbookId }),
        // Returns an unsubscribe function the panel calls on dismount.
        onSetupRequired: (callback: (event: unknown) => void): (() => void) => {
            const handler = (_event: unknown, data: unknown): void => {
                callback(data);
            };
            ipcRenderer.on('setup:required-event', handler);
            return (): void => {
                ipcRenderer.removeListener('setup:required-event', handler);
            };
        },
        // BPF-6 — subscribe to development-gate defer reasons so the Command
        // Center can toast WHY an "Approve" click didn't advance the phase.
        onGateDeferred: (callback: (event: unknown) => void): (() => void) => {
            const handler = (_event: unknown, data: unknown): void => {
                callback(data);
            };
            ipcRenderer.on('gate:deferred-event', handler);
            return (): void => {
                ipcRenderer.removeListener('gate:deferred-event', handler);
            };
        },
    },

    // ── APO Rollback (B-478) ─────────────────────
    listApoBackups: () =>
        ipcRenderer.invoke('apo:list-backups'),
    restoreApoBackup: (backupPath: string) =>
        ipcRenderer.invoke('apo:restore-backup', { backupPath }),

    // ── Task Output Viewer (v0.9) ────────────────
    getProjectTasks: (projectId: string) =>
        ipcRenderer.invoke('command-center:get-project-tasks', projectId),
    getTaskOutput: (taskId: string) =>
        ipcRenderer.invoke('command-center:get-task-output', taskId),

    // ── Task Checkpoint Timeline (P1-01f) ────────
    getTaskCheckpoints: (taskId: string) =>
        ipcRenderer.invoke('command-center:get-task-checkpoints', taskId),

    // ── Iteration history (P1-05b) ───────────────
    getIterationHistory: (projectId: string) =>
        ipcRenderer.invoke('iteration:get-history', projectId),

    // ── Revision proposals (P1-08b) ──────────────
    listRevisionProposal: (projectId: string, taskId: string) =>
        ipcRenderer.invoke('iteration:list-proposed', { projectId, taskId }),
    acceptRevisionProposal: (projectId: string, taskId: string) =>
        ipcRenderer.invoke('iteration:accept-proposal', { projectId, taskId }),
    rejectRevisionProposal: (projectId: string, taskId: string) =>
        ipcRenderer.invoke('iteration:reject-proposal', { projectId, taskId }),

    // ── Agent Detail Panel (v1.1) ────────────────
    getAgentDetail: (agentName: string, projectId?: string | null) =>
        ipcRenderer.invoke('command-center:get-agent-detail', agentName, projectId ?? null),

    // ── Team Members (C1) ────────────────────────
    getTeamMembers: () => ipcRenderer.invoke('command-center:get-team-members'),
    addTeamMember: (name: string, email: string, role: string) =>
        ipcRenderer.invoke('command-center:add-team-member', { name, email, role }),
    removeTeamMember: (id: string) =>
        ipcRenderer.invoke('command-center:remove-team-member', id),

    // ── Team Collaboration (Phase 3 Sprint 3) ────
    teamInviteMember: (email: string, role: string) =>
        ipcRenderer.invoke('team:invite-member', { email, role }),
    teamUpdateRole: (memberId: string, role: string) =>
        ipcRenderer.invoke('team:update-role', { memberId, role }),
    teamGetProjectAssignments: () =>
        ipcRenderer.invoke('team:get-project-assignments'),
    teamAssignToProject: (projectId: string, userId: string, userName: string, userEmail: string, role: string) =>
        ipcRenderer.invoke('team:assign-to-project', { projectId, userId, userName, userEmail, role }),
    teamRemoveAssignment: (assignmentId: string) =>
        ipcRenderer.invoke('team:remove-assignment', { assignmentId }),
    teamGetActivityFeed: (filter?: 'all' | 'humans' | 'agents') =>
        ipcRenderer.invoke('team:get-activity-feed', { filter }),
    onPresenceUpdate: (callback: (state: unknown) => void): void => {
        ipcRenderer.on('presence:update', (_event, state) => callback(state));
    },

    // ── Task Comments + Claims (Phase 3 Sprint 4) ────
    taskGetComments: (taskId: string) =>
        ipcRenderer.invoke('task:get-comments', { taskId }),
    taskAddComment: (taskId: string, authorType: 'human' | 'agent', authorName: string, body: string) =>
        ipcRenderer.invoke('task:add-comment', { taskId, authorType, authorName, body }),
    taskGetClaim: (taskId: string) =>
        ipcRenderer.invoke('task:get-claim', { taskId }),
    taskClaimTask: (taskId: string, userId: string, userName: string) =>
        ipcRenderer.invoke('team:claim-task', { taskId, userId, userName }),
    taskUnclaimTask: (taskId: string, userId: string) =>
        ipcRenderer.invoke('team:unclaim-task', { taskId, userId }),

    // ── Owner transfer (PR F of F-302 V1, F-326) ─
    teamRequestOwnershipTransfer: (args: {
        projectId: string;
        fromUserId: string;
        fromUserName: string;
        toUserId: string;
        toUserName: string;
        note?: string;
        orgId?: string;
    }) => ipcRenderer.invoke('team:request-ownership-transfer', args),
    teamAcceptOwnershipTransfer: (args: { transferId: string; callerUserId: string }) =>
        ipcRenderer.invoke('team:accept-ownership-transfer', args),
    teamDeclineOwnershipTransfer: (args: { transferId: string; callerUserId: string }) =>
        ipcRenderer.invoke('team:decline-ownership-transfer', args),
    teamListPendingTransfers: (callerUserId: string) =>
        ipcRenderer.invoke('team:list-pending-transfers', { callerUserId }),

    // ── Connectors (Phase 3 Sprint 5; F-373/F-374 added WhatsApp + Drive) ────────────
    connectorGetConfig: (name: string) =>
        ipcRenderer.invoke('connector:get-config', { name }),
    connectorSaveConfig: (name: string, config: Record<string, unknown>) =>
        ipcRenderer.invoke('connector:save-config', { name, config }),
    connectorTest: (name: string, config: Record<string, unknown>) =>
        ipcRenderer.invoke('connector:test', { name, config }),

    // ── Google Drive OAuth (F-374b) ──────────────
    gdriveSignIn: () => ipcRenderer.invoke('gdrive:sign-in'),
    gdriveSignOut: () => ipcRenderer.invoke('gdrive:sign-out'),
    gdriveStatus: () => ipcRenderer.invoke('gdrive:status'),
    gdriveListFolders: () => ipcRenderer.invoke('gdrive:list-folders'),

    // ── Agent Management (C2) ────────────────────
    getAgentConfigs: () => ipcRenderer.invoke('command-center:get-agent-configs'),
    setAgentEnabled: (agentName: string, enabled: boolean) =>
        ipcRenderer.invoke('command-center:set-agent-enabled', { agentName, enabled }),

    // ── Document Upload (E1) ─────────────────────
    getProjectDocuments: (projectId: string) =>
        ipcRenderer.invoke('command-center:get-project-documents', projectId),
    getProjectDocumentContent: (projectId: string, documentId: string) =>
        ipcRenderer.invoke('command-center:get-project-document-content', { projectId, documentId }),
    uploadDocument: (projectId: string, fileName: string, fileData: string, mimeType: string) =>
        ipcRenderer.invoke('command-center:upload-document', { projectId, fileName, fileData, mimeType }),
    deleteDocument: (id: string, projectId: string) =>
        ipcRenderer.invoke('command-center:delete-document', { id, projectId }),

    // ── Phase Graph (RAG) ────────────────────────
    getPhaseGraph: (projectId: string) =>
        ipcRenderer.invoke('command-center:get-phase-graph', projectId),

    // ── Configuration Module ─────────────────────────────────
    // True only in the commercial build; the open build hides commercial-only UI.
    getCommercialAvailable: () => ipcRenderer.invoke('app:commercial-available'),
    getConfigSnapshot: () => ipcRenderer.invoke('config:get-snapshot'),
    // F-322 / decision #76 — auto-update opt-out toggle + manual check
    getUpdateStatus: () => ipcRenderer.invoke('updates:get-status'),
    setAutoUpdateEnabled: (enabled: boolean) =>
        ipcRenderer.invoke('updates:set-auto-enabled', { enabled }),
    checkForUpdatesNow: () => ipcRenderer.invoke('updates:check-now'),
    // F-395 — operator-facing release channel override
    setReleaseChannel: (channel: 'latest' | 'beta' | null) =>
        ipcRenderer.invoke('updates:set-channel', { channel }),

    configSaveApiKey: (provider: string, key: string) => ipcRenderer.invoke('config:save-api-key', { provider, key }),
    // F-313: copy a present env var value into the keychain so the env var
    // becomes redundant (user can then delete it from .env / shell / system env).
    configPromoteEnvKey: (provider: string) => ipcRenderer.invoke('config:promote-env-key', { provider }),
    configDeleteApiKey: (provider: string) => ipcRenderer.invoke('config:delete-api-key', { provider }),
    testProvider: (provider: string) => ipcRenderer.invoke('config:test-provider', { provider }),
    saveEnvVar: (key: string, value: string) => ipcRenderer.invoke('config:save-env-var', { key, value }),
    getEnvVars: () => ipcRenderer.invoke('config:get-env-vars'),
    setAgentProvider: (agentName: string, provider: string, model: string) =>
        ipcRenderer.invoke('config:set-agent-provider', { agentName, provider, model }),

    // ── Provider Key Registry ──────────────────────
    listProviderKeys: (provider?: string, projectId?: string | null) =>
        ipcRenderer.invoke('config:list-provider-keys', { provider, projectId }),
    addProviderKey: (provider: string, label: string, apiKey: string, projectId?: string | null, isDefault?: boolean) =>
        ipcRenderer.invoke('config:add-provider-key', { provider, label, apiKey, projectId, isDefault }),
    updateProviderKey: (keyId: string, updates: { label?: string; isDefault?: boolean; projectId?: string | null; apiKey?: string }) =>
        ipcRenderer.invoke('config:update-provider-key', { keyId, ...updates }),
    deleteProviderKey: (keyId: string) =>
        ipcRenderer.invoke('config:delete-provider-key', { keyId }),

    // ── Project Lifecycle (v2.4) ────────────────
    listProjectsFiltered: (filter?: {
        include?: readonly string[];
        exclude?: readonly string[];
        includeArchived?: boolean;
    }) => ipcRenderer.invoke('command-center:list-projects-filtered', filter ?? {}),
    cancelProject: (projectId: string, reason?: string) =>
        ipcRenderer.invoke('command-center:project-cancel', projectId, reason ?? null),
    pauseProject: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-pause', projectId),
    resumeProject: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-resume', projectId),
    archiveProject: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-archive', projectId),
    restoreProject: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-restore', projectId),
    deleteProject: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-delete', projectId),
    // F-308 + F-309 — reopen / close terminal projects
    reopenProject: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-reopen', projectId),
    closeProject: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-close', projectId),
    // F-148 (#148) — mid-flight requirement injection
    addProjectRequirement: (projectId: string, text: string) =>
        ipcRenderer.invoke('orchestrator:add-requirement', { projectId, text }),
    retryFailedTasks: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-retry-failed', projectId),
    restartProject: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-restart', projectId),
    dryRunProject: (name: string, description: string) =>
        ipcRenderer.invoke('command-center:project-dry-run', name, description),

    // ── Project Start Split-Button (B-400) ──────
    startProjectDryRun: (args: { name: string; description: string }) =>
        ipcRenderer.invoke('project:start-dry-run', args),
    startProjectLiveRun: (args: {
        name: string;
        description: string;
        maxUsd?: number;
        preset?: string;
        trustLevel?: 'low' | 'medium' | 'high';
    }) =>
        ipcRenderer.invoke('project:start-live-run', args),
    onProjectRunProgress: (callback: (payload: unknown) => void) => {
        ipcRenderer.on('project:run-progress', (_event, data) => callback(data));
    },

    // ── Artifact Browser (v2.4) ─────────────────
    listArtifacts: (projectId: string, subPath: string = '') =>
        ipcRenderer.invoke('command-center:artifact-list', { projectId, subPath }),
    readArtifact: (projectId: string, relPath: string) =>
        ipcRenderer.invoke('command-center:artifact-read', { projectId, relPath }),
    downloadArtifactZip: (projectId: string) =>
        ipcRenderer.invoke('command-center:artifact-download-zip', { projectId }),

    // ── Artifact Browser — tree + preview (B-420/421/422) ─────
    listArtifactTree: (projectId: string, maxDepth?: number) =>
        ipcRenderer.invoke('artifacts:list-tree', { projectId, maxDepth }),
    readArtifactFile: (projectId: string, relPath: string) =>
        ipcRenderer.invoke('artifacts:read-file', { projectId, relPath }),

    // ── Artifact Browser — live preview server (B-425) ───
    startLivePreview: (projectId: string) =>
        ipcRenderer.invoke('artifacts:live-preview-start', { projectId }),
    stopLivePreview: (projectId: string) =>
        ipcRenderer.invoke('artifacts:live-preview-stop', { projectId }),

    // ── Artifact Browser — delete + push-to-GitHub (B-426/B-427) ───
    deleteArtifactPath: (projectId: string, relPath: string, recursive: boolean) =>
        ipcRenderer.invoke('artifacts:delete-path', { projectId, relPath, recursive }),
    pushProjectToGitHub: (projectId: string, opts?: { owner?: string; repo?: string; private?: boolean }) =>
        ipcRenderer.invoke('command-center:project-push-github', { projectId, ...(opts ?? {}) }),

    // ── Artifact Browser — task-level file metadata (B-428) ─────
    getArtifactTaskDetails: (projectId: string, taskId: string) =>
        ipcRenderer.invoke('artifacts:get-task-details', { projectId, taskId }),

    // ── Artifact Browser — content search (B-429) ──
    searchArtifacts: (
        projectId: string,
        query: string,
        opts?: { caseSensitive?: boolean; regex?: boolean; maxResults?: number },
    ) => ipcRenderer.invoke('artifacts:search', { projectId, query, ...(opts ?? {}) }),

    // ── Project metadata inline edit (B-406) ──────
    updateProjectMetadata: (
        projectId: string,
        updates: { name?: string; description?: string; trustLevel?: 'low' | 'medium' | 'high' },
    ) => ipcRenderer.invoke('command-center:project-update-metadata', { projectId, ...updates }),
    getProjectMetadata: (projectId: string) =>
        ipcRenderer.invoke('command-center:project-get-metadata', { projectId }),

    // ── APO History / Diff (v0.11) ──────────────
    listPromptOptimizations: (opts?: { agentName?: string; status?: string; limit?: number }) =>
        ipcRenderer.invoke('apo:list-optimizations', opts ?? {}),
    getPromptOptimization: (id: string) =>
        ipcRenderer.invoke('apo:get-optimization', { id }),

    // ── APO Accept / Reject (v0.12 P4) ───────────
    acceptPromptOptimization: (id: string) =>
        ipcRenderer.invoke('apo:accept-optimization', { id }),
    rejectPromptOptimization: (id: string) =>
        ipcRenderer.invoke('apo:reject-optimization', { id }),

    // ── Agent Intercept (v2.3) ────────────────────
    pauseAgent: (agentName: string, taskId: string) =>
        ipcRenderer.invoke('command-center:pause-agent', { agentName, taskId }),
    resumeAgent: (agentName: string, taskId: string) =>
        ipcRenderer.invoke('command-center:resume-agent', { agentName, taskId }),
    injectGuidance: (agentName: string, taskId: string, guidance: string) =>
        ipcRenderer.invoke('command-center:inject-guidance', { agentName, taskId, guidance }),
    takeoverTask: (agentName: string, taskId: string) =>
        ipcRenderer.invoke('command-center:takeover-task', { agentName, taskId }),
    handbackTask: (taskId: string, agentName: string, guidance?: string) =>
        ipcRenderer.invoke('command-center:handback-task', { taskId, agentName, guidance }),

    // ── Live Updates (push from main) ────────────
    onSenseiMessage: (callback: (message: string) => void) => {
        ipcRenderer.on('command-center:sensei-response', (_event, message) => callback(message));
    },
    onAgentUpdate: (callback: (agents: unknown) => void) => {
        ipcRenderer.on('command-center:agent-update', (_event, agents) => callback(agents));
    },
    onProjectUpdate: (callback: (projects: unknown) => void) => {
        ipcRenderer.on('command-center:project-update', (_event, projects) => callback(projects));
    },
    onApprovalNeeded: (callback: (approval: unknown) => void) => {
        ipcRenderer.on('command-center:approval-needed', (_event, approval) => callback(approval));
    },
    onActivityEvent: (callback: (event: unknown) => void) => {
        ipcRenderer.on('command-center:activity-event', (_event, data) => callback(data));
    },

    // ── Agent Intercept — push events (v2.3) ────
    onAgentStreamEvent: (callback: (event: unknown) => void) => {
        ipcRenderer.on('command-center:agent-stream-event', (_event, data) => callback(data));
    },
    onInterceptAck: (callback: (ack: unknown) => void) => {
        ipcRenderer.on('command-center:intercept-ack', (_event, data) => callback(data));
    },

    // ── Network resilience events (v0.12 Track D) ───
    onNetworkEvent: (callback: (event: unknown) => void) => {
        ipcRenderer.on('command-center:network-event', (_event, data) => callback(data));
    },

    // ── Agent Terminal panel (B-497) ───────────────
    // Subscribe to read-only subprocess stdout/stderr scoped to a single
    // projectId. Main fires `command-center:agent-terminal-output` for
    // every chunk; the preload filters here so renderer code stays small.
    // Returns an unsubscribe function the panel calls on dismount.
    subscribeAgentTerminal: (
        projectId: string,
        callback: (event: unknown) => void,
    ): (() => void) => {
        const handler = (_event: unknown, data: unknown): void => {
            // Filter by projectId in the preload so renderer-side panels
            // never see chunks meant for other projects.
            if (typeof data === 'object' && data !== null) {
                const rec = data as Record<string, unknown>;
                if (rec['projectId'] === projectId) {
                    callback(data);
                }
            }
        };
        ipcRenderer.on('command-center:agent-terminal-output', handler);
        return (): void => {
            ipcRenderer.removeListener('command-center:agent-terminal-output', handler);
        };
    },

    // Same channel as subscribeAgentTerminal but no projectId filter — the
    // all-project agent-logs panel needs every chunk regardless of source.
    subscribeAllAgentOutput: (callback: (event: unknown) => void): (() => void) => {
        const handler = (_event: unknown, data: unknown): void => {
            callback(data);
        };
        ipcRenderer.on('command-center:agent-terminal-output', handler);
        return (): void => {
            ipcRenderer.removeListener('command-center:agent-terminal-output', handler);
        };
    },

    // ── Setup Wizard / Onboarding (Phase 2) ────────
    onboarding: {
        getState: () => ipcRenderer.invoke('onboarding:get-state'),
        advance: (
            input:
                | { type: 'begin' }
                | { type: 'select-preset'; preset: string }
                | { type: 'select-trust'; trustLevel: 'low' | 'medium' | 'high' }
                | { type: 'set-providers'; providers: ReadonlyArray<{ name: string; apiKeyConfigured: boolean }> }
                | { type: 'set-budget'; budgetCapUsd: number }
                | { type: 'back' },
        ) => ipcRenderer.invoke('onboarding:advance', input),
    },

    // ── Per-Project Quickflow (Phase 3) ─────────────
    quickflow: {
        // Returns last project's settings (or wizard defaults if empty).
        // Shape: { ok: boolean, source?: 'last-project'|'wizard-defaults',
        //          defaults?: { preset, trustLevel, budgetCapUsd }, error? }
        getDefaults: () => ipcRenderer.invoke('quickflow:get-defaults'),
    },

    // Fixed, parameterless projects-empty check (used by wizard for
    // first-launch detection). KO-SEC-002: no SQL string ever crosses IPC.
    projectsIsEmpty: (): Promise<{ empty: boolean }> =>
        ipcRenderer.invoke('projects:is-empty'),

    // ── Shell utilities ─────────────────────────────
    openPath: (args: { projectId: string | null; filePath: string }): Promise<string> =>
        ipcRenderer.invoke('shell:open-path', args),

    // ── Interactive Shell (B-510) ───────────────────
    // Renderer drives a child-process session: spawn → input lines → kill.
    // Output streams back via onShellOutput; SHELL_EXIT fires when the child
    // exits. All filtering happens in the panel since one renderer can run
    // multiple sessions side-by-side.
    shellSpawn: (sessionId: string, shellType: string, cwd: string): void => {
        ipcRenderer.send('command-center:shell-spawn', sessionId, shellType, cwd);
    },
    shellInput: (sessionId: string, line: string): void => {
        ipcRenderer.send('command-center:shell-input', sessionId, line);
    },
    shellKill: (sessionId: string): void => {
        ipcRenderer.send('command-center:shell-kill', sessionId);
    },
    onShellOutput: (callback: (data: unknown) => void): (() => void) => {
        const handler = (_event: unknown, data: unknown): void => callback(data);
        ipcRenderer.on('command-center:shell-output', handler);
        return (): void => {
            ipcRenderer.removeListener('command-center:shell-output', handler);
        };
    },
    onShellExit: (callback: (data: unknown) => void): (() => void) => {
        const handler = (_event: unknown, data: unknown): void => callback(data);
        ipcRenderer.on('command-center:shell-exit', handler);
        return (): void => {
            ipcRenderer.removeListener('command-center:shell-exit', handler);
        };
    },
});
