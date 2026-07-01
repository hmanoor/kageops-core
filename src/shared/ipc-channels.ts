export const IPC = {
  // Command Center — Cost Intelligence (v0.7)
  GET_OPERATIONAL_COSTS: 'command-center:get-operational-costs',

  // Command Center — Run Budgets (B-449) — per-project budget_usd
  GET_RUN_BUDGETS:   'command-center:get-run-budgets',
  SET_PROJECT_BUDGET:'command-center:set-project-budget',

  // Command Center — Code Graph (v0.8)
  GET_GRAPH_STATUS: 'command-center:get-graph-status',
  GET_GRAPH_STATUSES: 'command-center:get-graph-statuses',

  // GitHub Integration (v0.9)
  SET_GITHUB_TOKEN: 'settings:set-github-token',
  GET_GITHUB_STATUS: 'settings:get-github-status',
  SET_PROJECT_GITHUB: 'command-center:set-project-github',

  // Model Config & System Status (v1.0)
  GET_AGENT_MODEL_CONFIGS: 'command-center:get-agent-model-configs',
  SET_AGENT_MODEL: 'command-center:set-agent-model',
  TEST_AGENT_MODEL: 'command-center:test-agent-model',
  GET_SYSTEM_STATUS: 'command-center:get-system-status',

  // Deployments (v1.1)
  GET_DEPLOYMENTS: 'deployments:get',
  SAVE_DEPLOYMENT: 'deployments:save',
  DELETE_DEPLOYMENT: 'deployments:delete',

  // Task output viewer (v0.9)
  GET_TASK_OUTPUT: 'command-center:get-task-output',
  GET_PROJECT_TASKS: 'command-center:get-project-tasks',

  // Agent detail panel (v1.1)
  GET_AGENT_DETAIL: 'command-center:get-agent-detail',

  // Team Members (C1)
  GET_TEAM_MEMBERS: 'command-center:get-team-members',
  ADD_TEAM_MEMBER: 'command-center:add-team-member',
  REMOVE_TEAM_MEMBER: 'command-center:remove-team-member',

  // Agent Management (C2)
  GET_AGENT_CONFIGS: 'command-center:get-agent-configs',
  SET_AGENT_ENABLED: 'command-center:set-agent-enabled',

  // Document Upload (E1)
  GET_PROJECT_DOCUMENTS: 'command-center:get-project-documents',
  UPLOAD_DOCUMENT: 'command-center:upload-document',
  DELETE_DOCUMENT: 'command-center:delete-document',

  // Configuration Module
  GET_CONFIG_SNAPSHOT: 'config:get-snapshot',
  SAVE_API_KEY: 'config:save-api-key',
  DELETE_API_KEY: 'config:delete-api-key',
  TEST_PROVIDER: 'config:test-provider',
  SAVE_ENV_VAR: 'config:save-env-var',
  GET_ENV_VARS: 'config:get-env-vars',
  SET_AGENT_PROVIDER: 'config:set-agent-provider',

  // Provider Key Registry
  LIST_PROVIDER_KEYS: 'config:list-provider-keys',
  ADD_PROVIDER_KEY: 'config:add-provider-key',
  UPDATE_PROVIDER_KEY: 'config:update-provider-key',
  DELETE_PROVIDER_KEY: 'config:delete-provider-key',

  // Phase Graph (RAG)
  GET_PHASE_GRAPH: 'command-center:get-phase-graph',

  // Approval Details (expanded view)
  GET_APPROVAL_DETAILS: 'command-center:get-approval-details',

  // First-run Onboarding State Machine
  ONBOARDING_GET_STATE: 'onboarding:get-state',
  ONBOARDING_ADVANCE: 'onboarding:advance',

  // Per-Project Quickflow (setup wizard Phase 3)
  // Returns the most recent project's preset/budget/trust as defaults so
  // the New Project modal can prefill them. Falls back to the wizard's
  // saved defaults from onboarding state when no projects exist yet.
  QUICKFLOW_GET_DEFAULTS: 'quickflow:get-defaults',

  // Agent Intercept (v2.3) — Renderer → Main
  PAUSE_AGENT: 'command-center:pause-agent',
  RESUME_AGENT: 'command-center:resume-agent',
  INJECT_GUIDANCE: 'command-center:inject-guidance',
  TAKEOVER_TASK: 'command-center:takeover-task',
  HANDBACK_TASK: 'command-center:handback-task',

  // Agent Intercept (v2.3) — Main → Renderer (push)
  AGENT_STREAM_EVENT: 'command-center:agent-stream-event',
  INTERCEPT_ACK: 'command-center:intercept-ack',

  // Project Lifecycle (v2.4)
  PROJECT_CANCEL:  'command-center:project-cancel',
  PROJECT_PAUSE:   'command-center:project-pause',
  PROJECT_RESUME:  'command-center:project-resume',
  PROJECT_ARCHIVE: 'command-center:project-archive',
  PROJECT_RESTORE: 'command-center:project-restore',
  PROJECT_DELETE:  'command-center:project-delete',
  PROJECT_RESTART: 'command-center:project-restart',
  // F-308 + F-309 — explicit reopen/close after project completion
  PROJECT_REOPEN:  'command-center:project-reopen',
  PROJECT_CLOSE:   'command-center:project-close',
  PROJECT_DRY_RUN: 'command-center:project-dry-run',
  LIST_PROJECTS_FILTERED: 'command-center:list-projects-filtered',
  // F-148 — Mid-flight requirement injection (#148)
  PROJECT_ADD_REQUIREMENT: 'orchestrator:add-requirement',

  // Project Start (B-400) — split-button Dry Run / Live Run
  PROJECT_START_DRY_RUN:  'project:start-dry-run',
  PROJECT_START_LIVE_RUN: 'project:start-live-run',
  PROJECT_RUN_PROGRESS:   'project:run-progress',

  // Artifact Browser (v2.4)
  ARTIFACT_LIST:          'command-center:artifact-list',
  ARTIFACT_READ:          'command-center:artifact-read',
  ARTIFACT_DOWNLOAD_ZIP:  'command-center:artifact-download-zip',

  // Artifact Browser — file tree + preview (B-420/B-421/B-422)
  ARTIFACT_LIST_TREE:     'artifacts:list-tree',
  ARTIFACT_READ_FILE:     'artifacts:read-file',

  // Artifact Browser — live preview server (B-425)
  ARTIFACT_LIVE_START:    'artifacts:live-preview-start',
  ARTIFACT_LIVE_STOP:     'artifacts:live-preview-stop',

  // Artifact Browser — delete file/dir (B-426) + push-to-GitHub (B-427)
  ARTIFACT_DELETE:        'artifacts:delete-path',
  PROJECT_PUSH_GITHUB:    'command-center:project-push-github',

  // Artifact Browser — task-level file metadata (B-428)
  ARTIFACT_GET_TASK_DETAILS: 'artifacts:get-task-details',

  // Artifact Browser — content search within a project (B-429)
  ARTIFACT_SEARCH:        'artifacts:search',

  // Project metadata inline edit (B-406)
  PROJECT_UPDATE_METADATA: 'command-center:project-update-metadata',
  PROJECT_GET_METADATA:    'command-center:project-get-metadata',

  // APO Rollback (B-478)
  APO_LIST_BACKUPS:   'apo:list-backups',
  APO_RESTORE_BACKUP: 'apo:restore-backup',

  // APO History / Diff (v0.11)
  APO_LIST_OPTIMIZATIONS: 'apo:list-optimizations',
  APO_GET_OPTIMIZATION:   'apo:get-optimization',

  // APO Accept / Reject (v0.12 — P4 human-in-the-loop)
  APO_ACCEPT_OPTIMIZATION: 'apo:accept-optimization',
  APO_REJECT_OPTIMIZATION: 'apo:reject-optimization',

  // Network resilience toast (v0.12 Track D) — Main → Renderer push
  NETWORK_EVENT: 'command-center:network-event',

  // Agent Terminal (B-497) — read-only subprocess stdout/stderr tailing.
  // Renderer asks main to scope its push stream to a single projectId.
  AGENT_TERMINAL_SUBSCRIBE:   'command-center:agent-terminal-subscribe',
  AGENT_TERMINAL_UNSUBSCRIBE: 'command-center:agent-terminal-unsubscribe',
  // Main → Renderer push, scoped by projectId on the renderer side.
  AGENT_TERMINAL_OUTPUT:      'command-center:agent-terminal-output',

  // Interactive Shell (B-510) — renderer-driven child-process sessions for the
  // Command Center inline terminal. Renderer → Main: spawn / input / kill.
  // Main → Renderer push: SHELL_OUTPUT (stdout+stderr chunks), SHELL_EXIT.
  SHELL_SPAWN:  'command-center:shell-spawn',
  SHELL_INPUT:  'command-center:shell-input',
  SHELL_KILL:   'command-center:shell-kill',
  SHELL_OUTPUT: 'command-center:shell-output',
  SHELL_EXIT:   'command-center:shell-exit',

  // GreenThumb Database (v0.11 Phase 3)
  DB_QUERY: 'db:query',

  // GreenThumb Error Logging (v0.11 Phase 3)
  LOG_ERROR: 'log:error',

  // Auth (Phase 3) — Renderer → Main
  AUTH_GET_CLERK_KEY:    'auth:get-clerk-key',
  AUTH_COMPLETE:         'auth:complete',
  AUTH_CANCEL:           'auth:cancel',
  AUTH_SIGN_OUT:         'auth:sign-out',

  // Device-flow auth (post-pivot) — Renderer → Main
  AUTH_DEVICE_FLOW_START:       'auth:device-flow-start',
  AUTH_DEVICE_FLOW_START_FRESH: 'auth:device-flow-start-fresh',
  AUTH_DEVICE_FLOW_CANCEL:      'auth:device-flow-cancel',

  // Current signed-in user (Command Center renderer reads this on init
  // to render the user pill in the top-bar)
  AUTH_GET_CURRENT_USER:   'auth:get-current-user',

  // Auth (Phase 3) — Main → Renderer push
  AUTH_USER_CHANGED:     'auth:user-changed',
  AUTH_SIGNED_OUT:       'auth:signed-out',

  // Plan Selection (Phase 3 Sprint 2) — Renderer → Main
  PLAN_GET_STRIPE_KEY:   'plan:get-stripe-key',
  PLAN_OPEN_CHECKOUT:    'plan:open-checkout',
  PLAN_OPEN_PORTAL:      'plan:open-portal',
  PLAN_CONTINUE_FREE:    'plan:continue-free',
  PLAN_GET_SESSION:      'plan:get-session',
  // Re-open the Plan window from inside Command Center (Manage plan
  // menu item). Differs from PLAN_OPEN_PORTAL: this surfaces the tier
  // picker so free users can upgrade and paid users can compare /
  // change tier. Paid users can still click the in-window 'Manage
  // billing' which opens the Stripe Customer Portal.
  PLAN_REOPEN:           'plan:reopen',

  // Plan Selection (Phase 3 Sprint 2) — Main → Renderer push
  PLAN_STRIPE_CALLBACK:  'plan:stripe-callback',

  // Plan confirm — renderer calls this after Stripe success to proceed to Command Center
  PLAN_CONFIRM_SELECTED: 'plan:confirm-selected',

  // Team Collaboration (Phase 3 Sprint 3) — Renderer → Main
  TEAM_INVITE_MEMBER:         'team:invite-member',
  TEAM_UPDATE_ROLE:           'team:update-role',
  TEAM_GET_PROJECT_ASSIGNMENTS: 'team:get-project-assignments',
  TEAM_ASSIGN_TO_PROJECT:     'team:assign-to-project',
  TEAM_REMOVE_ASSIGNMENT:     'team:remove-assignment',
  TEAM_GET_ACTIVITY_FEED:     'team:get-activity-feed',
  TEAM_CLAIM_TASK:            'team:claim-task',
  TEAM_UNCLAIM_TASK:          'team:unclaim-task',
  TEAM_GET_ORG_SETTINGS:      'team:get-org-settings',
  TEAM_SAVE_ORG_SETTINGS:     'team:save-org-settings',

  // Owner transfer (PR F of F-302 V1, F-326)
  TEAM_REQUEST_OWNERSHIP_TRANSFER: 'team:request-ownership-transfer',
  TEAM_ACCEPT_OWNERSHIP_TRANSFER:  'team:accept-ownership-transfer',
  TEAM_DECLINE_OWNERSHIP_TRANSFER: 'team:decline-ownership-transfer',
  TEAM_LIST_PENDING_TRANSFERS:     'team:list-pending-transfers',

  // Presence (Phase 3 Sprint 3) — Main → Renderer push
  PRESENCE_UPDATE:            'presence:update',

  // Task Comments (Phase 3 Sprint 4)
  TASK_GET_COMMENTS:    'task:get-comments',
  TASK_ADD_COMMENT:     'task:add-comment',
  TASK_GET_CLAIM:       'task:get-claim',
  TEAM_UNCLAIM_TASK_IPC: 'team:unclaim-task',

  // Connectors (Phase 3 Sprint 5)
  CONNECTOR_GET_CONFIG:  'connector:get-config',
  CONNECTOR_SAVE_CONFIG: 'connector:save-config',
  CONNECTOR_TEST:        'connector:test',

  // Google Drive OAuth (F-374b — Sign in with Google)
  GDRIVE_SIGN_IN:        'gdrive:sign-in',
  GDRIVE_SIGN_OUT:       'gdrive:sign-out',
  GDRIVE_STATUS:         'gdrive:status',
  GDRIVE_LIST_FOLDERS:   'gdrive:list-folders',

  // Welcome / Onboarding (Sprint 2) — Renderer → Main
  WELCOME_DISMISS:       'welcome:dismiss',
  WELCOME_OPEN_DOCS:     'welcome:open-docs',
  WELCOME_QUICK_ACTION:  'welcome:quick-action',
  WELCOME_GET_VERSION:   'welcome:get-version',

  // Bundle discovery for the New-Project modal (Pillar 2.2 PR-B.2 / D-A)
  LIST_BUNDLES:                   'bundles:list',

  // Deployment Config (Pillar 2.2 PR-B.1)
  DEPLOYMENT_CONFIG_GET:          'deployment-config:get',
  DEPLOYMENT_CONFIG_SAVE:         'deployment-config:save',
  DEPLOYMENT_CONFIG_CLEAR:        'deployment-config:clear',
  DEPLOYMENT_CONFIG_HAS:          'deployment-config:has',
  DEPLOYMENT_CONFIG_TEST_SECRET:  'deployment-config:test-secret',
  DEPLOYMENT_CONFIG_GET_VERCEL_TOKEN_STATUS: 'deployment-config:get-vercel-token-status',
  DEPLOYMENT_CONFIG_SAVE_VERCEL_TOKEN:       'deployment-config:save-vercel-token',
  DEPLOYMENT_CONFIG_CLEAR_VERCEL_TOKEN:      'deployment-config:clear-vercel-token',
  DEPLOYMENT_CONFIG_OPEN_VENDOR_URL:         'deployment-config:open-vendor-url',
  // Phase 2b — OS-keychain "key register" for app secrets.
  DEPLOYMENT_CONFIG_SAVE_APP_ENV:            'deployment-config:save-app-env',
  DEPLOYMENT_CONFIG_APP_ENV_STATUS:          'deployment-config:app-env-status',
  DEPLOYMENT_CONFIG_CLEAR_APP_ENV:           'deployment-config:clear-app-env',

  // Cloud Burst (Pillar 2.4 / PR-E.1 + PR-F) — Renderer → Main
  CLOUD_BURST_DISPATCH:           'cloud-burst:dispatch',
  CLOUD_BURST_LIST_ACTIVE:        'cloud-burst:list-active',
  CLOUD_BURST_LIST_FOR_PROJECT:   'cloud-burst:list-for-project',
  CLOUD_BURST_LIST_RECENT:        'cloud-burst:list-recent',
  CLOUD_BURST_STOP:               'cloud-burst:stop',
  CLOUD_BURST_STOP_ALL:           'cloud-burst:stop-all',

  // Cloud Burst pool CRUD (Pillar 2.4 / PR-G) — Renderer → Main
  BURST_POOL_LIST:                'burst-pool:list',
  BURST_POOL_GET:                 'burst-pool:get',
  BURST_POOL_CREATE:              'burst-pool:create',
  BURST_POOL_UPDATE:              'burst-pool:update',
  BURST_POOL_DELETE:              'burst-pool:delete',

  // Azure Environments registry CRUD (Pillar 2.5 / PR-C) — Renderer → Main
  // One environment row = one operator Azure (subscription / RG / region
  // [+ tenant + credential ref]). Both Cloud Burst pools and (future)
  // deploy targets reference it instead of re-typing coordinates (D-A).
  AZURE_ENV_LIST:                 'azure-env:list',
  AZURE_ENV_GET:                  'azure-env:get',
  AZURE_ENV_CREATE:               'azure-env:create',
  AZURE_ENV_UPDATE:               'azure-env:update',
  AZURE_ENV_DELETE:               'azure-env:delete',

  // Deploy targets + runs (Pillar 2.5 / PR-G) — Renderer → Main
  // A deploy_target = "deploy this project to this Azure environment as
  // this service type." The Deploy button triggers an orchestrated run
  // (provision → deploy → live). The service type is auto-suggested from
  // the project type (D-E, operator confirms); deploys are manual-trigger
  // only (D-F). DEPLOY_RUN_* feed the live run status the panel renders.
  DEPLOY_TARGET_LIST:             'deploy-target:list',
  DEPLOY_TARGET_GET:              'deploy-target:get',
  DEPLOY_TARGET_CREATE:           'deploy-target:create',
  DEPLOY_TARGET_DELETE:           'deploy-target:delete',
  DEPLOY_SUGGEST_SERVICE:         'deploy:suggest-service',
  DEPLOY_TRIGGER:                 'deploy:trigger',
  // PR-H: one-click teardown of the live Azure resource (D-J, cost safety).
  DEPLOY_TEARDOWN:                'deploy:teardown',
  DEPLOY_RUN_LIST_RECENT:         'deploy-run:list-recent',
  DEPLOY_RUN_LIST_BY_TARGET:      'deploy-run:list-by-target',

  // Unified per-client cost (Pillar 2.5 / PR-I, D-I) — Renderer → Main
  // Rolls Cloud Burst compute actuals + estimated deploy hosting cost up
  // per client (projects.client_id), with a CSV export for billing.
  COST_GET_CLIENT_ROLLUP:         'cost:get-client-rollup',
  COST_EXPORT_CLIENTS:            'cost:export-clients',

  // Agent-image ACR import (Pillar 2.5 / PR-K, D-M) — Renderer → Main
  // One-click server-side `az acr import` of the public agent image into
  // the operator's own ACR (no local Docker). PR-L's setup copilot wraps it.
  ACR_IMPORT_AGENT_IMAGE:         'acr:import-agent-image',

  // Sensei setup copilot (Pillar 2.5 / PR-L, D-N) — Renderer → Main
  // Read-only discovery of setup gaps (proposes the next bounded playbook)
  // + the verifyAzureConnectivity check. Mutating playbooks reuse their own
  // shipped IPC (e.g. acr:import-agent-image) after operator confirm.
  SETUP_LIST_PROPOSALS:           'setup:list-proposals',
  SETUP_VERIFY_CONNECTIVITY:      'setup:verify-connectivity',

  // App-credential setup copilot (MCC-8 / Slice 4) — Renderer → Main
  // Per-project credential ledger: list outstanding app-credential proposals
  // and provide a credential (validate-on-entry → persist to deployment_config).
  SETUP_LIST_APP_PROPOSALS:       'setup:list-app-proposals',
  SETUP_PROVIDE_CREDENTIAL:       'setup:provide-credential',
  // L3 auto-provision (MCC-8 / Slice 5): run an `execute` playbook (create the
  // Stripe Price / register the webhook) test-mode and persist the produced value.
  SETUP_PROVISION_CREDENTIAL:     'setup:provision-credential',
  // Main → Renderer push: Sensei raised a `setup.required` event mid-run so
  // the ledger panel can surface the needed credential without a manual refresh.
  SETUP_REQUIRED_EVENT:           'setup:required-event',
  // BPF-6 — Main → Renderer push: a development-gate approval deferred; carries
  // the reason so the Command Center can toast WHY "Approve" didn't advance.
  GATE_DEFERRED_EVENT:            'gate:deferred-event',
} as const;
