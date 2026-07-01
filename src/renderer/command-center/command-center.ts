/**
 * KageOps Command Center — Renderer Script
 *
 * Initializes all panels, wires IPC callbacks, handles user interactions.
 */

import { marked } from 'marked';
import { initViewSwitcher, registerViewInit, switchToView, type ViewId } from './view-switcher';
import { initActivityBar, type ActivityBarHandle, type ActivityBarView } from './activity-bar';
import { initPanelResize } from './panel-resize';
import { initCommandPalette, openCommandPalette, registerCommand } from './command-palette';
import { initKnowledgeBaseView } from './knowledge-base-view';
import { initAutonautsView } from './autonauts-view';
import { ThinkingRotator } from '../shared/thinking-rotator';
import { renderMatrixPanel } from './matrix-panel';
import { renderCostPanel } from './cost-panel';
import { renderBuildPanel, type BuildEntry } from './build-panel';
import { renderNotificationPanel } from './notification-panel';
import {
    renderCostIntelligencePanel,
    OperationalCostSummary,
    RunBudgetEntry,
} from './cost-intelligence-panel';
import {
    renderCodeGraphPanel,
    updateGraphifyBuildProgress,
    showGraphInViewer,
    type GraphifyProjectEntry,
    type GraphifyProgressEvent,
    type GraphifyBuildState,
    type CodeGraphCallbacks,
} from './code-graph-panel';
import type { CodeGraphStatus } from '../../workspace/mcp-types';
import { renderGitHubPanel } from './github-panel';
import { renderStatusBar, renderStatusBarError, pulseLiveHud } from './status-bar';
import { renderModelRoutingPanel, AgentModelConfig } from './model-routing-panel';
import {
    mountSetupWizard,
    shouldFireOnFirstLaunch,
    type WizardCompletionDefaults,
} from './setup-wizard';
import {
    attachQuickflow,
    showQuickflow,
    hideQuickflow,
} from './new-project-quickflow';
import {
    DeploymentConfigSection,
    defaultDeploymentConfigBridge,
    type BundleSummary,
    type BundleDeployment,
} from './deployment-config-section';
import { renderAzureEnvironmentsPanel, defaultAzureEnvironmentsPanelDeps } from './azure-environments-panel';
import { renderDeployTargetsPanel, defaultDeployTargetsPanelDeps } from './deploy-targets-panel';
import { renderClientCostPanel, defaultClientCostPanelDeps } from './client-cost-panel';
import { renderSetupCopilotPanel, defaultSetupCopilotPanelDeps } from './setup-copilot-panel';
import {
    renderAppCredentialPanel,
    defaultAppCredentialPanelDeps,
    type AppCredentialPanelHandle,
} from './app-credential-panel';
import { renderCloudBurstPanel, defaultCloudBurstPanelDeps } from './cloud-burst-panel';
import { renderApoRollbackPanel, ApoRollbackPanelCallbacks } from './apo-rollback-panel';
import {
    renderApoHistoryPanel,
    type ApoHistoryCallbacks,
    type PromptOptimizationRecord as ApoHistoryRecord,
} from './apo-history-panel';
import { renderTaskOutputPanel } from './task-output-panel';
import { renderAgentDetailPanel } from './agent-detail-panel';
import { renderTeamMembersPanel } from './team-members-panel';
import { renderAgentManagementPanel, AgentConfig } from './agent-management-panel';
import { getSigilHtml } from './sigils';
import { renderDocumentUploadPanel } from './document-upload-panel';
import { renderArtifactBrowserPanel } from './artifact-browser-panel';
import { renderPhaseGraphPanel, PhaseGraphData } from './phase-graph-panel';
import { renderConfigPanel } from './config-panel';
import { initAgentTerminalPanel, type AgentTerminalHandle } from './agent-terminal-panel';
import { initHelpPanel } from './help-panel';
import {
    initProjectBoardView,
    type BoardProject,
    type BoardAgent,
    type ProjectBoardApi,
} from './project-board-view';
import { initAgentLogsPanel } from './agent-logs-panel';
import { initInteractiveShellPanel } from './interactive-shell-panel';
import { renderConnectorsPanel } from './connectors-panel';
import { renderOrchestrationFlow, FlowAgentState } from './orchestration-flow-panel';
import { initNetworkToast, type NetworkEventPayload, type NetworkToastHandle } from './network-toast';
import { applyProjectFilter, uniqueSorted } from './project-filter';
import { hydrateIcons, icon, type IconName } from '../../shared/icons';
import {
    PHASE_CATALOGUE,
    QUICK_PRESETS,
    derivePhaseTaskSelectionsPayload,
    getPreset,
    taskTypesForPhase,
    type PhaseTaskSelections,
} from '../../shared/phase-task-catalogue';
import type { Phase } from '../../orchestrator/task-decomposer';

// ── Types ────────────────────────────────────────────

interface SystemStatus {
    dbConnected: boolean;
    orchestratorRunning: boolean;
    activeAgents: number;
    totalProjects: number;
    version: string;
    bootstrapError?: string | null;
}

/** Notification row as it arrives from the main process IPC handler.
 *  Mirrors `command-center:get-notifications` in src/main/main.ts. */
interface NotificationFromIpc {
    readonly id: string;
    readonly type: 'info' | 'success' | 'warning' | 'error';
    readonly eventType: string | null;
    readonly title: string;
    readonly message: string;
    readonly agent: string | null;
    readonly projectId: string | null;
    readonly projectName: string | null;
    readonly timestamp: string;
    readonly read: boolean;
}

interface KageOpsApi {
    getCurrentUser(): Promise<{
        userId: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        plan: string;
    } | null>;
    signOut(): Promise<void>;
    reopenPlanWindow(): Promise<{ ok: boolean; error?: string }>;
    getCommercialAvailable(): Promise<boolean>;
    getProjects(): Promise<ProjectInfo[]>;
    getKnowledgeBaseProjects(): Promise<ProjectInfo[]>;
    getBuilds(): Promise<readonly unknown[]>;
    getAgents(): Promise<AgentInfo[]>;
    getApprovalQueue(): Promise<ApprovalInfo[]>;
    getApprovalDetails(projectId: string): Promise<ApprovalDetails | null>;
    getApprovalHistory(): Promise<readonly ApprovalHistoryEntry[]>;
    approveGate(projectId: string): Promise<void>;
    denyGate(projectId: string): Promise<void>;
    startProject(name: string, description: string): Promise<{ id: string | null; error: string | null }>;
    getAgentStreamHistory(args: { agent: string; taskId?: string | null; limit?: number }): Promise<readonly {
        readonly time: string;
        readonly agent: string;
        readonly taskId: string | null;
        readonly projectId: string | null;
        readonly data: Record<string, unknown>;
    }[]>;
    startProjectAdvanced(args: {
        name: string;
        description: string;
        trustLevel?: 'low' | 'medium' | 'high';
        enabledPhases?: readonly string[];
        projectType?: string;
        techStack?: string;
        goal?: string;
        budgetUsd?: number;
        phaseTaskSelections?: PhaseTaskSelections | null;
    }): Promise<{ id: string | null; error: string | null }>;
    // Pillar 2.2 / PR-B.2 — Bundle discovery + deployment config bridge
    listBundles(): Promise<{
        success: boolean;
        bundles: readonly {
            name: string;
            kind: 'stack' | 'capability' | 'deployer';
            description: string;
            deployment: unknown | null;
        }[];
        error?: string;
    }>;
    deploymentConfig: {
        get(projectId: string): Promise<{ success: boolean; values?: Record<string, string> | null; error?: string }>;
        save(projectId: string, values: Record<string, string>): Promise<{ success: boolean; error?: string }>;
        clear(projectId: string): Promise<{ success: boolean; error?: string }>;
        has(projectId: string): Promise<{ success: boolean; present: boolean; error?: string }>;
        testSecret(provider: string, value: string): Promise<{ success: boolean; result?: { code: string; latencyMs: number; identity?: string }; error?: string }>;
        getVercelTokenStatus(): Promise<{ success: boolean; present: boolean; error?: string }>;
        saveVercelToken(token: string): Promise<{ success: boolean; error?: string }>;
        clearVercelToken(): Promise<{ success: boolean; error?: string }>;
        openVendorUrl(url: string): Promise<{ success: boolean; error?: string }>;
        saveAppEnv(projectId: string, values: Record<string, string>): Promise<{ success: boolean; error?: string }>;
        appEnvStatus(projectId: string): Promise<{ success: boolean; present: boolean; error?: string }>;
        clearAppEnv(projectId: string): Promise<{ success: boolean; error?: string }>;
    };
    sendToSensei(message: string): Promise<string>;
    getOperationalCosts(windowDays?: number): Promise<OperationalCostSummary | null>;
    getRunBudgets(): Promise<readonly RunBudgetEntry[]>;
    setProjectBudget(projectId: string, capUsd: number): Promise<{ ok: boolean; capUsd?: number; clamped?: boolean; error?: string }>;
    getGraphStatus(repoPath: string): Promise<CodeGraphStatus | null>;
    getGraphStatuses(): Promise<readonly CodeGraphStatus[]>;
    getGraphifyGraphs(): Promise<readonly GraphifyProjectEntry[]>;
    runGraphify(projectId: string, repoPath: string): Promise<{ ok: boolean; error?: string }>;
    onGraphifyProgress(cb: (event: GraphifyProgressEvent) => void): () => void;
    readGraphHtml(filePath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
    openExternal(url: string): Promise<void>;
    setGitHubToken(token: string): Promise<{ success: boolean; error?: string }>;
    getGitHubStatus(): Promise<{ hasToken: boolean }>;
    setProjectGitHub(projectId: string, owner: string, repo: string): Promise<{ success: boolean; error?: string }>;
    getAgentModelConfigs(): Promise<AgentModelConfig[]>;
    setAgentModel(agentName: string, model: string, provider: string): Promise<{ success: boolean; error?: string }>;
    testAgentModel(agentName: string, model: string, provider: string): Promise<{ success: boolean; latencyMs?: number; error?: string }>;
    listPresets(): Promise<{ presets: readonly { name: string; label: string; description: string; exists: boolean; isBuiltIn?: boolean }[]; active: string | null }>;
    setActivePreset(preset: string | null): Promise<{ success: boolean; active?: string | null; error?: string }>;
    createPreset(
        name: string,
        agents: Record<string, { model: string; provider: string; fallbackModels?: readonly string[] }>,
        overwrite?: boolean,
    ): Promise<{ success: boolean; name?: string; error?: string }>;
    deletePreset(name: string): Promise<{ success: boolean; error?: string }>;
    getPreset(name: string): Promise<{ success: boolean; config?: { agents: Record<string, { model: string; provider: string; fallbackModels?: readonly string[] }> }; error?: string }>;
    listDesignProviders(): Promise<{ providers: readonly { id: string; label: string; description: string; available: boolean }[]; active: string }>;
    setActiveDesignProvider(providerId: string): Promise<{ success: boolean; active?: string; error?: string }>;
    getDeployments(): Promise<unknown[]>;
    saveDeployment(target: unknown): Promise<{ success: boolean; error?: string }>;
    deleteDeployment(id: string): Promise<{ success: boolean; error?: string }>;
    listApoBackups(): Promise<{
        success: boolean;
        error?: string;
        entries: readonly {
            readonly backupPath: string;
            readonly presetPath: string;
            readonly timestamp: number;
            readonly createdAt: string;
            readonly size: number;
            readonly agentsWithOverrides: readonly string[];
        }[];
    }>;
    restoreApoBackup(backupPath: string): Promise<{ success: boolean; error?: string }>;
    getSystemStatus(): Promise<SystemStatus>;
    getNotifications(): Promise<readonly NotificationFromIpc[]>;
    getProjectTasks(projectId: string): Promise<unknown[]>;
    getTaskOutput(taskId: string): Promise<unknown>;
    getTaskCheckpoints(taskId: string): Promise<unknown[]>;
    // P1-05b — read-only iteration history for a project (oldest first).
    getIterationHistory(projectId: string): Promise<unknown[]>;
    // P1-08b — revision proposal lifecycle (operator accept/reject surface).
    listRevisionProposal(projectId: string, taskId: string): Promise<unknown>;
    acceptRevisionProposal(projectId: string, taskId: string): Promise<{ ok: boolean; accepted?: readonly string[]; error?: string }>;
    rejectRevisionProposal(projectId: string, taskId: string): Promise<{ ok: boolean; error?: string }>;
    getAgentDetail(agentName: string): Promise<unknown>;
    getMatrix(): Promise<unknown[]>;
    getTeamMembers(): Promise<unknown[]>;
    addTeamMember(name: string, email: string, role: string): Promise<{ success: boolean; error?: string }>;
    removeTeamMember(id: string): Promise<{ success: boolean; error?: string }>;
    teamInviteMember(email: string, role: string): Promise<{ success: boolean; error?: string }>;
    taskGetComments(taskId: string): Promise<unknown[]>;
    taskAddComment(taskId: string, authorType: 'human' | 'agent', authorName: string, body: string): Promise<{ success: boolean; error?: string }>;
    taskGetClaim(taskId: string): Promise<{ claimed_by_user_id: string | null; claimed_by_user_name: string | null; claimed_at: string | null }>;
    taskClaimTask(taskId: string, userId: string, userName: string): Promise<{ success: boolean; error?: string }>;
    taskUnclaimTask(taskId: string, userId: string): Promise<{ success: boolean; error?: string }>;
    // Connectors (Phase 3 Sprint 5; F-373/F-374 widened the config shape).
    connectorGetConfig(name: string): Promise<import('../../connectors/types').ConnectorConfig>;
    connectorSaveConfig(name: string, config: import('../../connectors/types').ConnectorConfig): Promise<{ success: boolean; error?: string }>;
    connectorTest(name: string, config: import('../../connectors/types').ConnectorConfig): Promise<{ ok: boolean; error?: string }>;
    // F-374b — Google Drive OAuth via loopback + PKCE.
    gdriveStatus(): Promise<{ configured: boolean; signedIn: boolean; email: string | null }>;
    gdriveSignIn(): Promise<{ ok: boolean; email?: string; error?: string }>;
    gdriveSignOut(): Promise<{ ok: boolean }>;
    gdriveListFolders(): Promise<{ ok: boolean; folders?: ReadonlyArray<{ id: string; name: string }>; error?: string }>;
    teamUpdateRole(memberId: string, role: string): Promise<{ success: boolean; error?: string }>;
    teamGetProjectAssignments(): Promise<unknown[]>;
    teamAssignToProject(projectId: string, userId: string, userName: string, userEmail: string, role: string): Promise<{ success: boolean; error?: string }>;
    teamRemoveAssignment(assignmentId: string): Promise<{ success: boolean; error?: string }>;
    teamGetActivityFeed(filter?: 'all' | 'humans' | 'agents'): Promise<unknown[]>;
    onPresenceUpdate(callback: (state: unknown) => void): void;
    getAgentConfigs(): Promise<AgentConfig[]>;
    setAgentEnabled(agentName: string, enabled: boolean): Promise<{ success: boolean; error?: string }>;
    getProjectDocuments(projectId: string): Promise<unknown[]>;
    getProjectDocumentContent(projectId: string, documentId: string): Promise<{ success: boolean; content?: string; error?: string; mimeType?: string }>;
    uploadDocument(projectId: string, fileName: string, fileData: string, mimeType: string): Promise<{ success: boolean; error?: string; id?: string }>;
    deleteDocument(id: string, projectId: string): Promise<{ success: boolean; error?: string }>;
    getPhaseGraph(projectId: string): Promise<PhaseGraphData>;
    getConfigSnapshot(): Promise<unknown>;
    configSaveApiKey(provider: string, key: string): Promise<{ success: boolean; error?: string }>;
    configPromoteEnvKey(provider: string): Promise<{ success: boolean; error?: string }>;
    configDeleteApiKey(provider: string): Promise<{ success: boolean; error?: string }>;
    testProvider(provider: string): Promise<{ success: boolean; latencyMs?: number; error?: string }>;
    saveEnvVar(key: string, value: string): Promise<{ success: boolean; error?: string }>;
    getEnvVars(): Promise<unknown>;
    setAgentProvider(agentName: string, provider: string, model: string): Promise<{ success: boolean; error?: string }>;
    listProviderKeys(provider?: string, projectId?: string | null): Promise<{ success: boolean; keys: readonly unknown[]; error?: string }>;
    addProviderKey(provider: string, label: string, apiKey: string, projectId?: string | null, isDefault?: boolean): Promise<{ success: boolean; key?: unknown; error?: string }>;
    updateProviderKey(keyId: string, updates: { label?: string; isDefault?: boolean; projectId?: string | null; apiKey?: string }): Promise<{ success: boolean; error?: string }>;
    deleteProviderKey(keyId: string): Promise<{ success: boolean; error?: string }>;
    // Agent Intercept (v2.3)
    pauseAgent(agentName: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    resumeAgent(agentName: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    injectGuidance(agentName: string, taskId: string, guidance: string): Promise<{ success: boolean; error?: string }>;
    takeoverTask(agentName: string, taskId: string): Promise<{ success: boolean; error?: string }>;
    handbackTask(taskId: string, agentName: string, guidance?: string): Promise<{ success: boolean; error?: string }>;
    // Project Lifecycle (v2.4)
    listProjectsFiltered(filter?: {
        include?: readonly string[];
        exclude?: readonly string[];
        includeArchived?: boolean;
    }): Promise<ProjectInfo[]>;
    cancelProject(projectId: string, reason?: string): Promise<{ success: boolean; error?: string }>;
    pauseProject(projectId: string): Promise<{ success: boolean; error?: string }>;
    resumeProject(projectId: string): Promise<{ success: boolean; error?: string }>;
    archiveProject(projectId: string): Promise<{ success: boolean; error?: string }>;
    restoreProject(projectId: string): Promise<{ success: boolean; error?: string }>;
    // F-308 + F-309 — flip a terminal-status project (completed / cancelled /
    // archived) back to active so Sensei can dispatch new work on it. The
    // alternative — telling the user to type `/reopen-project <uuid>` into
    // chat — was unworkable since users cannot type UUIDs reliably.
    reopenProject(projectId: string): Promise<{
        success: boolean;
        error?: string;
        changed?: boolean;
        status?: string;
        fromStatus?: string;
    }>;
    deleteProject(projectId: string): Promise<{ success: boolean; error?: string }>;
    // F-148 (#148) — append a new requirement to an in-flight project. Sensei
    // decomposes 1-3 follow-up tasks for the current phase and routes them.
    // Refused for terminal / launch-growth / low-trust mid-development states.
    addProjectRequirement(projectId: string, text: string): Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly newTaskCount?: number;
        readonly affectedPhase?: string;
    }>;
    retryFailedTasks(projectId: string): Promise<{ success: boolean; retried?: number; error?: string }>;
    restartProject(projectId: string): Promise<{ success: boolean; requeued?: number; error?: string }>;
    dryRunProject(name: string, description: string): Promise<{ success: boolean; preview?: string; error?: string }>;
    // Project Start Split-Button (B-400)
    startProjectDryRun(args: { name: string; description: string }): Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly result?: ProjectRunResult;
    }>;
    startProjectLiveRun(args: {
        name: string;
        description: string;
        maxUsd?: number;
        preset?: string;
        trustLevel?: 'low' | 'medium' | 'high';
    }): Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly projectId?: string;
        readonly maxUsd?: number;
    }>;
    onProjectRunProgress(callback: (payload: ProjectRunProgress) => void): void;
    // Artifact Browser (v2.4)
    listArtifacts(projectId: string, subPath?: string): Promise<{ success: boolean; nodes: readonly ArtifactNode[]; error?: string }>;
    readArtifact(projectId: string, relPath: string): Promise<{ success: boolean; preview?: ArtifactPreview; error?: string }>;
    downloadArtifactZip(projectId: string): Promise<{ success: boolean; path?: string; error?: string }>;
    // Artifact Browser — tree + preview (B-420/421/422)
    listArtifactTree(projectId: string, maxDepth?: number): Promise<{
        readonly success: boolean;
        readonly nodes: readonly ArtifactTreeNode[];
        readonly error?: string;
    }>;
    readArtifactFile(projectId: string, relPath: string): Promise<{
        readonly success: boolean;
        readonly file?: ArtifactFileReadResult;
        readonly error?: string;
    }>;
    // Artifact Browser — live preview server (B-425)
    startLivePreview(projectId: string): Promise<{
        readonly success: boolean;
        readonly url?: string;
        readonly port?: number;
        readonly error?: string;
    }>;
    stopLivePreview(projectId: string): Promise<{ readonly success: boolean; readonly error?: string }>;
    // Artifact Browser — delete + push-to-GitHub (B-426 / B-427)
    deleteArtifactPath(projectId: string, relPath: string, recursive: boolean): Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly kind?: 'file' | 'dir';
    }>;
    pushProjectToGitHub(projectId: string, opts?: {
        readonly owner?: string;
        readonly repo?: string;
        readonly private?: boolean;
    }): Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly repoUrl?: string;
        readonly branch?: string;
        readonly owner?: string;
        readonly repo?: string;
        readonly created?: boolean;
    }>;
    // Artifact Browser — task-level file metadata (B-428)
    getArtifactTaskDetails(projectId: string, taskId: string): Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly task?: {
            readonly id: string;
            readonly title: string;
            readonly description: string | null;
            readonly status: string;
            readonly phase: string;
            readonly taskType: string | null;
            readonly assignedAgent: string | null;
            readonly retryCount: number;
            readonly qualityScore: number | null;
            readonly errorMessage: string | null;
            readonly branchName: string | null;
            readonly outputPath: string | null;
            readonly createdAtIso: string;
            readonly startedAtIso: string | null;
            readonly completedAtIso: string | null;
            readonly totalCostUsd: number | null;
            readonly totalTokensIn: number | null;
            readonly totalTokensOut: number | null;
            readonly lastModel: string | null;
        } | null;
    }>;
    // Artifact Browser — content search (B-429)
    searchArtifacts(
        projectId: string,
        query: string,
        opts?: { caseSensitive?: boolean; regex?: boolean; maxResults?: number },
    ): Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly results: readonly {
            readonly relPath: string;
            readonly matches: readonly {
                readonly line: number;
                readonly content: string;
                readonly columnStart: number;
                readonly columnEnd: number;
            }[];
        }[];
        readonly totalMatches: number;
        readonly truncated: boolean;
        readonly durationMs: number;
        readonly filesScanned: number;
    }>;
    // Project metadata inline edit (B-406)
    updateProjectMetadata(
        projectId: string,
        updates: { name?: string; description?: string; trustLevel?: 'low' | 'medium' | 'high' },
    ): Promise<{ readonly success: boolean; readonly error?: string }>;
    getProjectMetadata(projectId: string): Promise<{
        readonly success: boolean;
        readonly error?: string;
        readonly metadata?: {
            readonly name: string;
            readonly description: string;
            readonly trustLevel: 'low' | 'medium' | 'high';
        };
    }>;
    // APO History / Diff (v0.11)
    listPromptOptimizations(opts?: { agentName?: string; status?: string; limit?: number }): Promise<{
        readonly success: boolean;
        readonly records: readonly ApoHistoryRecord[];
        readonly error?: string;
    }>;
    getPromptOptimization(id: string): Promise<{
        readonly success: boolean;
        readonly record: ApoHistoryRecord | null;
        readonly error?: string;
    }>;
    // APO Accept / Reject (v0.12 P4)
    acceptPromptOptimization(id: string): Promise<{
        readonly success: boolean;
        readonly record: ApoHistoryRecord | null;
        readonly error?: string;
    }>;
    rejectPromptOptimization(id: string): Promise<{
        readonly success: boolean;
        readonly record: ApoHistoryRecord | null;
        readonly error?: string;
    }>;
    onSenseiMessage(callback: (message: string) => void): void;
    onAgentUpdate(callback: (agents: AgentInfo[]) => void): void;
    onProjectUpdate(callback: (projects: ProjectInfo[]) => void): void;
    onApprovalNeeded(callback: (approval: ApprovalInfo) => void): void;
    onActivityEvent(callback: (event: ActivityEvent) => void): void;
    onAgentStreamEvent(callback: (event: AgentStreamEvent) => void): void;
    onInterceptAck(callback: (ack: InterceptAckEvent) => void): void;
    onNetworkEvent(callback: (event: NetworkEventPayload) => void): void;
    subscribeAgentTerminal(
        projectId: string,
        callback: (event: unknown) => void,
    ): () => void;
    subscribeAllAgentOutput(callback: (event: unknown) => void): () => void;
    openPath(args: { projectId: string | null; filePath: string }): Promise<string>;
}

interface AgentStreamEvent {
    readonly time: string;
    readonly agent: string;
    readonly taskId: string;
    readonly projectId: string;
    readonly data: unknown;
}

interface InterceptAckEvent {
    readonly agent: string;
    readonly taskId: string;
    readonly data: unknown;
}

interface ProjectInfo {
    id: string;
    name: string;
    phase: string;
    status: string;
    trustLevel: string;
    taskCounts: {
        total: number;
        pending: number;
        assigned: number;
        completed: number;
        failed: number;
    };
    // P1-05b: how many times this project has been reopened. 0 =
    // original build. Optional + defaulted to 0 so older main-process
    // bridges that don't surface the field don't break the renderer.
    reopenCount?: number;
    lastReopenedAt?: string | null;
}

// P1-05b: one iteration cycle as returned by `iteration:get-history`.
interface IterationHistoryEntry {
    id: string;
    iterationIndex: number;
    startedAt: string;
    endedAt: string | null;
    requirementText: string | null;
}

// B-400 — shape returned by `startProjectDryRun`
interface ProjectRunResult {
    readonly projectId: string;
    readonly finalPhase: string;
    readonly phasesVisited: readonly string[];
    readonly tasksCompleted: number;
    readonly tasksFailed: number;
    readonly totalCostUsd: number;
    readonly durationMs: number;
    readonly gateVerdicts: {
        readonly build?: 'pass' | 'fail' | 'skipped';
        readonly acceptance?: 'pass' | 'fail' | 'skipped';
    };
    readonly escalations: readonly string[];
}

// B-400 — streamed on `project:run-progress`
interface ProjectRunProgress {
    readonly kind: 'started' | 'event' | 'complete' | 'error';
    readonly mode: 'dry-run' | 'live';
    readonly projectId?: string;
    readonly event?: { readonly channel: string; readonly timestamp: string; readonly data?: unknown };
    readonly result?: ProjectRunResult;
    readonly error?: string;
}

interface ArtifactNode {
    readonly name: string;
    readonly relPath: string;
    readonly type: 'file' | 'dir';
    readonly size?: number;
    readonly mtime?: number;
    readonly producedBy?: { readonly agent: string; readonly taskId: string };
}

interface ArtifactPreview {
    readonly kind: 'text' | 'markdown' | 'code' | 'html' | 'image' | 'binary';
    readonly language?: string;
    readonly text?: string;
    readonly dataUrl?: string;
    readonly sizeBytes: number;
    readonly truncated: boolean;
    readonly mimeType: string;
}

// Artifact Browser — tree + preview (B-420/421/422)

interface ArtifactTreeNode {
    readonly name: string;
    readonly path: string;
    readonly type: 'file' | 'dir';
    readonly size?: number;
    readonly mtime?: number;
    readonly children?: readonly ArtifactTreeNode[];
}

interface ArtifactFileReadResult {
    readonly content: string | null;
    readonly encoding: 'utf8' | 'base64';
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly mtimeIso: string;
    readonly isBinary: boolean;
}

type ProjectTab = 'active' | 'completed' | 'archived';

interface AgentInfo {
    name: string;
    role: string;
    status: 'idle' | 'busy' | 'error';
    currentTaskTitle: string | null;
    model?: string | null;
    provider?: string | null;
}

interface ApprovalInfo {
    id: string;
    name: string;
    phase: string;
    status: string;
    trustLevel?: string;
    taskCounts?: {
        total: number;
        pending: number;
        assigned: number;
        completed: number;
        failed: number;
    };
}

interface ApprovalDetailTask {
    readonly title: string;
    readonly taskType: string | null;
    readonly assignedAgent: string | null;
    readonly status: string;
    readonly qualityScore: number | null;
}

interface ApprovalDetails {
    readonly projectId: string;
    readonly currentPhase: string;
    readonly nextPhase: string | null;
    readonly description: string | null;
    readonly completedTasks: readonly ApprovalDetailTask[];
    readonly phaseDescription: string;
    readonly nextPhaseDescription: string;
}

interface ActivityEvent {
    time: string;
    agent: string;
    message: string;
    /** Optional full event payload — present for AI-exchange and other
     *  rich events. Used when the user clicks the row to drill into
     *  prompt+response details. */
    channel?: string;
    data?: unknown;
}

declare const kageOps: KageOpsApi;

// ── State ────────────────────────────────────────────

const MAX_ACTIVITY_ITEMS = 100;
let activityItems: ActivityEvent[] = [];
let cachedAgentStates: FlowAgentState[] = [];
/** Latest "active" project phase — drives the phase-strip highlight in
 *  the orchestration flow panel. Null when no project is in flight. */
let cachedActivePhase: string | null = null;

// ── DOM References ───────────────────────────────────

function $(selector: string): HTMLElement | null {
    return document.querySelector(selector);
}

// ── Initialize ───────────────────────────────────────

// OSS gate: true only when the commercial layer (KageOps Cloud) is loaded.
// Resolved once at boot; downstream code hides the commercial-only UI when false.
// Defaults true so a missing bridge (older preload) doesn't hide paid features.
let commercialUiAvailable = true;

document.addEventListener('DOMContentLoaded', async () => {
    // Resolve commercial availability first — the rail, panels, and menu below
    // are gated on it so the open build never shows dead commercial UI.
    try {
        commercialUiAvailable = await (kageOps.getCommercialAvailable?.() ?? Promise.resolve(true));
    } catch {
        commercialUiAvailable = true;
    }

    // Replace static data-icon placeholders in index.html with inline SVGs.
    hydrateIcons();

    // View switcher — must init before panels so tabs work
    initViewSwitcher();

    // Register lazy-init views (called on first tab switch)
    registerViewInit('au', () => {
        const container = document.getElementById('view-au');
        if (container === null) return;
        container.innerHTML = '';
        initAutonautsView(container, {
            getAgents: () => kageOps.getAgents() as Promise<never[]>,
            getAgentDetail: (name) => kageOps.getAgentDetail(name) as Promise<never>,
            getMatrix: () => kageOps.getMatrix() as Promise<never[]>,
            getAgentModelConfigs: () => kageOps.getAgentModelConfigs() as Promise<never[]>,
            getAgentConfigs: () => kageOps.getAgentConfigs() as Promise<never[]>,
            setAgentModel: (name, model, provider) => kageOps.setAgentModel(name, model, provider),
            testAgentModel: (name, model, provider) => kageOps.testAgentModel(name, model, provider),
            setAgentEnabled: (name, enabled) => kageOps.setAgentEnabled(name, enabled),
            sendToSensei: (msg) => kageOps.sendToSensei(msg),
            getOperationalCosts: (days) => kageOps.getOperationalCosts(days) as Promise<never>,
            pauseAgent: (name, taskId) => kageOps.pauseAgent(name, taskId),
            resumeAgent: (name, taskId) => kageOps.resumeAgent(name, taskId),
            injectGuidance: (name, taskId, guidance) => kageOps.injectGuidance(name, taskId, guidance),
            takeoverTask: (name, taskId) => kageOps.takeoverTask(name, taskId),
            handbackTask: (taskId, name, guidance) => kageOps.handbackTask(taskId, name, guidance),
            onAgentStreamEvent: (cb) => kageOps.onAgentStreamEvent(cb),
            onInterceptAck: (cb) => kageOps.onInterceptAck(cb),
            getAgentStreamHistory: (args) => kageOps.getAgentStreamHistory(args) as Promise<never[]>,
            listPresets: () => kageOps.listPresets(),
        });
    });

    registerViewInit('kb', () => {
        const container = document.getElementById('view-kb');
        if (container === null) return;
        container.innerHTML = '';
        // The IPC channels return snake_case DB rows (shared with
        // task-output-panel / document-upload-panel which still consume
        // that shape). The KB view was authored against a camelCase
        // contract and also filters tasks by hasOutput — which the
        // main-process response doesn't compute. Normalize here so the
        // KB gets what it expects without rippling through other panels.
        type RawTask = {
            readonly id: string; readonly title: string;
            readonly task_type: string; readonly assigned_agent: string | null;
            readonly status: string; readonly output_path: string | null;
            readonly response_text: string | null;
            readonly completed_at: string | null;
        };
        type RawDoc = {
            readonly id: string; readonly file_name: string;
            readonly mime_type: string; readonly created_at: string;
        };
        initKnowledgeBaseView(container, {
            getProjects: () => kageOps.getKnowledgeBaseProjects() as Promise<never[]>,
            getProjectTasks: async (id) => {
                const rows = (await kageOps.getProjectTasks(id)) as readonly RawTask[];
                return rows.map((r) => ({
                    id: r.id,
                    title: r.title,
                    taskType: r.task_type,
                    assignedAgent: r.assigned_agent,
                    status: r.status,
                    completedAt: r.completed_at,
                    hasOutput: r.output_path !== null || r.response_text !== null,
                })) as never[];
            },
            getTaskOutput: (id) => kageOps.getTaskOutput(id) as Promise<never>,
            getProjectDocuments: async (id) => {
                const rows = (await kageOps.getProjectDocuments(id)) as readonly RawDoc[];
                return rows.map((r) => ({
                    id: r.id,
                    fileName: r.file_name,
                    mimeType: r.mime_type,
                    createdAt: r.created_at,
                })) as never[];
            },
            getProjectDocumentContent: (projectId, documentId) =>
                kageOps.getProjectDocumentContent(projectId, documentId) as Promise<never>,
            getGraphStatuses: () => kageOps.getGraphStatuses() as Promise<never[]>,
        });
    });

    registerViewInit('board', () => {
        const container = document.getElementById('project-board-body');
        if (container === null) return;
        const api: ProjectBoardApi = {
            listProjects: async () => {
                // The board's "All Projects" tab is meant to show every
                // non-archived project the user can drill into — that's
                // active runs PLUS the completed history. The legacy
                // kageOps.getProjects() endpoint filters out both
                // 'completed' and 'archived' by default (it powers the
                // sidebar's "Active" tab), which is why completed runs
                // were missing from the board. Use the filtered endpoint
                // so completed shows up; archived stays hidden because
                // those are the user-removed ones.
                const projects = (await kageOps.listProjectsFiltered({ exclude: ['archived'] })) as readonly ProjectInfo[];
                return projects.map((p): BoardProject => ({
                    id: p.id,
                    name: p.name,
                    status: p.status,
                    current_phase: p.phase,
                    taskCounts: p.taskCounts,
                }));
            },
            getProjectTasks: async (projectId) => {
                const rows = (await kageOps.getProjectTasks(projectId)) as readonly {
                    readonly id: string;
                    readonly title: string;
                    readonly task_type: string | null;
                    readonly assigned_agent: string;
                    readonly status: string;
                    readonly phase: string;
                    readonly priority: number;
                    readonly completed_at: string | null;
                    readonly output_path: string | null;
                    readonly response_text: string | null;
                }[];
                return rows;
            },
            getAgents: async () => {
                const agents = (await kageOps.getAgents()) as readonly AgentInfo[];
                return agents.map((a): BoardAgent => ({
                    name: a.name,
                    status: a.status,
                }));
            },
            onActivityEvent: (cb) => {
                kageOps.onActivityEvent(cb);
                // The legacy onActivityEvent IPC has no removeListener bridge;
                // return a no-op unsubscribe so the panel API contract holds.
                return () => undefined;
            },
            onOpenArtifact: (projectId, projectName, filePath) => {
                openArtifactBrowserPanel(projectId, projectName ?? projectId, filePath ?? undefined);
            },
        };
        initProjectBoardView(container, api);
    });


    initCollapsiblePanels();
    initPanelResize();
    initOperationModes();
    initSidebarResize();
    initProjectsPanel();
    initAgentsPanel();
    initApprovalQueue();
    initSenseiChat();
    initNewProjectModal();
    // PR #168: Start ▾ split-button + standalone Live Run modal removed —
    // the New Project modal now exposes both Dry Run and Create & Start as
    // explicit footer buttons. `initProjectRunProgress()` stays so the
    // event-stream toast surface keeps working for both paths.
    initProjectRunProgress();
    initDocAttachments();
    initLiveUpdates();
    initCodeGraphPanel();
    initGitHubPanel();
    initModelRoutingPanel();
    if (commercialUiAvailable) {
        // Commercial-only panels — hidden entirely in the open build (their
        // backends live in the KageOps Cloud layer).
        initDeploymentsPanel();
        initCloudBurstPanel();
        initTeamMembersPanel();
    }
    initApoRollbackPanel();
    initApoHistoryPanel();
    initConfigModule();
    initTerminalHubView();
    initHelpView();
    initOrchestrationFlow();
    initThemeToggle();
    initNotificationCenter();
    initUserPill();
    initLayoutCollapse();
    initShell();

    // Initial data load
    void refreshAll();

    // Live-push updates handle agents/projects/approvals in real time.
    // Poll the slower panels (graph, status bar) every 30s. The cost panel
    // refreshes every 5s during live runs so users can watch spend accumulate.
    setInterval(() => void refreshSlowPanels(), 30_000);
    setInterval(() => void refreshCostPanel(), 5_000);

    // Setup Wizard — Phase 2.
    // Auto-fire if this is a first launch (no completed onboarding state AND
    // empty projects table per Q6). When the user reaches the "ready" step
    // and clicks "Create your first project", we drop them into the existing
    // New Project modal with prefilled defaults (Q1).
    void (async () => {
        try {
            const should = await shouldFireOnFirstLaunch();
            if (!should) return;
            await mountSetupWizard({
                onCreateProject: (defaults: WizardCompletionDefaults) => {
                    storeQuickflowDefaults(defaults);
                    const btn = document.getElementById('btn-new-project');
                    if (btn) (btn as HTMLButtonElement).click();
                },
            });
        } catch (err) {
            console.warn('[wizard] auto-fire skipped', err);
        }
    })();
});

// ── Wizard → Quickflow defaults bridge ────────────────
// Stored in sessionStorage so the New Project modal (and later the Phase 3
// quickflow drawer) can read them. Cleared after the first project is created.
function storeQuickflowDefaults(d: WizardCompletionDefaults): void {
    try {
        sessionStorage.setItem('kageops:wizard-defaults', JSON.stringify(d));
    } catch {
        // sessionStorage may be unavailable in some contexts — non-fatal.
    }
}

// ── Theme Toggle ──────────────────────────────────────

function initThemeToggle(): void {
    const btn = document.getElementById('btn-theme-toggle');
    if (btn === null) return;

    // Restore saved theme + push the matching native title-bar overlay
    // colour so the Windows controls slot matches the surface tint.
    const saved = localStorage.getItem('kageops_theme') as 'dark' | 'light' | null;
    if (saved === 'light') {
        document.documentElement.dataset['theme'] = 'light';
        btn.textContent = '\u2600\uFE0F';
    }
    void pushTitleBarTheme();

    btn.addEventListener('click', () => {
        const current = document.documentElement.dataset['theme'] ?? 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset['theme'] = next;
        btn.textContent = next === 'dark' ? '\uD83C\uDF19' : '\u2600\uFE0F';
        localStorage.setItem('kageops_theme', next);
        void pushTitleBarTheme();
    });
}

/**
 * Tell the main process to repaint the native window-controls overlay
 * so the slate strip behind the Windows min/max/close buttons matches
 * the active theme. Without this, light-mode users see a black slab
 * sitting in the top-right corner of the window.
 */
async function pushTitleBarTheme(): Promise<void> {
    const theme = document.documentElement.dataset['theme'] ?? 'dark';
    const palette = theme === 'light'
        ? { color: '#FAFAFA', symbolColor: '#0A0A0A' }
        : { color: '#141414', symbolColor: '#B8B8B8' };
    try {
        const api = (window as unknown as { kageOps?: { setTitleBarOverlay?: (p: { color: string; symbolColor: string }) => Promise<void> } }).kageOps;
        if (api?.setTitleBarOverlay !== undefined) {
            await api.setTitleBarOverlay(palette);
        }
    } catch { /* no-op — best-effort */ }
}

// ── User pill (top-bar) ─────────────────────────────
//
// Shows the signed-in user as a pill (avatar initials + name) in
// the top-bar. Click toggles a dropdown menu with email + plan +
// Sign out. User info comes from the main process (auth-window's
// currentUser singleton) via IPC, populated on auth completion.

interface CurrentUser {
    readonly userId: string;
    readonly email: string;
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly plan: string;
}

function initialsFor(user: CurrentUser): string {
    const first = (user.firstName ?? '').trim();
    const last = (user.lastName ?? '').trim();
    if (first.length > 0 && last.length > 0) return (first[0]! + last[0]!).toUpperCase();
    if (first.length > 0) return first.slice(0, 2).toUpperCase();
    // Fall back to first two chars of the email local part
    const local = user.email.split('@')[0] ?? 'U';
    return local.slice(0, 2).toUpperCase();
}

function displayName(user: CurrentUser): string {
    const first = (user.firstName ?? '').trim();
    if (first.length > 0) return first;
    // Fall back to the email local part
    return user.email.split('@')[0] ?? 'User';
}

function initUserPill(): void {
    const pill = document.getElementById('btn-user-pill') as HTMLButtonElement | null;
    const menu = document.getElementById('user-menu') as HTMLDivElement | null;
    const avatarEl = document.getElementById('user-avatar');
    const nameEl = document.getElementById('user-name');
    const menuName = document.getElementById('user-menu-name');
    const menuEmail = document.getElementById('user-menu-email');
    const menuPlan = document.getElementById('user-menu-plan');
    const signOutBtn = document.getElementById('user-menu-signout') as HTMLButtonElement | null;

    if (pill === null || menu === null) return;

    // Fetch current user, render the pill. If no user yet (race with
    // auth completion), retry shortly.
    const render = async (): Promise<void> => {
        // Open build: hosted auth is commercial, so there's no current-user
        // handler — skip the fetch (and its retry loop) rather than spamming
        // "No handler registered for 'auth:get-current-user'". The account menu
        // is rewritten to the open-core funnel below.
        if (!commercialUiAvailable) return;
        const user = await (kageOps.getCurrentUser?.() as Promise<CurrentUser | null> | undefined);
        if (user === null || user === undefined) {
            // Retry once — likely a tiny race with auth completion writing
            // the singleton. If still null after, leave the placeholder.
            setTimeout(() => { void render(); }, 1500);
            return;
        }
        if (avatarEl !== null) avatarEl.textContent = initialsFor(user);
        if (nameEl !== null) nameEl.textContent = displayName(user);
        if (menuName !== null) menuName.textContent = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || displayName(user);
        if (menuEmail !== null) menuEmail.textContent = user.email;
        if (menuPlan !== null) menuPlan.textContent = user.plan;
    };
    void render();

    const closeMenu = (): void => {
        menu.hidden = true;
        pill.setAttribute('aria-expanded', 'false');
    };
    const toggleMenu = (): void => {
        const open = !menu.hidden;
        if (open) closeMenu();
        else {
            menu.hidden = false;
            pill.setAttribute('aria-expanded', 'true');
        }
    };

    pill.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleMenu();
    });

    // Click-outside to close
    document.addEventListener('click', (ev) => {
        if (menu.hidden) return;
        const target = ev.target as Node | null;
        if (target !== null && !menu.contains(target) && !pill.contains(target)) {
            closeMenu();
        }
    });
    // Esc to close
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !menu.hidden) {
            closeMenu();
            pill.focus();
        }
    });

    if (commercialUiAvailable) {
        signOutBtn?.addEventListener('click', () => {
            closeMenu();
            // Main process handles: tearing down all windows, clearing the
            // desktop JWT, re-opening the auth window.
            void (kageOps.signOut?.() as Promise<void> | undefined);
        });
    } else if (signOutBtn !== null) {
        // No hosted auth in the open build — nothing to sign out of.
        // ('.hidden' is overridden by the item's display:block, so hide directly.)
        signOutBtn.style.display = 'none';
    }

    const manageBtn = document.getElementById('user-menu-manage-plan') as HTMLButtonElement | null;
    if (manageBtn !== null && commercialUiAvailable) {
        // Commercial build — re-open the Plan window for billing operations.
        manageBtn.addEventListener('click', () => {
            closeMenu();
            void (kageOps.reopenPlanWindow?.() as Promise<{ ok: boolean; error?: string }> | undefined);
        });
    } else if (manageBtn !== null) {
        // ── Open-source build: turn the account menu into the open-core funnel ──
        // No in-app billing here, so advertise exactly what the paid tiers add
        // (the features the capability gate hides) + a community star nudge.
        const planBadge = document.getElementById('user-menu-plan');
        if (planBadge !== null) planBadge.textContent = 'Open Source';

        const promo = document.createElement('div');
        promo.className = 'user-menu__promo';
        promo.innerHTML =
            '<div class="user-menu__promo-title">☁ KageOps Cloud</div>' +
            '<div class="user-menu__promo-body">Team seats · cloud bursting · Slack / Discord / Teams — hosted for your team.</div>';
        manageBtn.parentElement?.insertBefore(promo, manageBtn);

        manageBtn.textContent = 'See plans & pricing ↗';
        manageBtn.classList.add('user-menu__item--cta');
        manageBtn.addEventListener('click', () => {
            closeMenu();
            void kageOps.openExternal?.('https://kageops.ai/#pricing');
        });

        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'user-menu__item user-menu__item--star';
        star.setAttribute('role', 'menuitem');
        star.innerHTML = '<span>★ Star KageOps on GitHub</span>';
        star.addEventListener('click', () => {
            closeMenu();
            void kageOps.openExternal?.('https://github.com/hmanoor/kageops-core');
        });
        manageBtn.insertAdjacentElement('afterend', star);
    }
}

// ── Notification Center ─────────────────────────────
//
// Bell button in the top bar opens an anchored popover containing
// the existing two-column notification inbox. New approval/activity
// events refresh the badge so unread count stays current. Read
// state is local-only (id list in localStorage) since the main
// process derives notifications on the fly from agent_logs.

const NOTIF_READ_KEY = 'kageops_notif_read_ids';
const NOTIF_REFRESH_DEBOUNCE_MS = 800;

let notifCache: readonly NotificationFromIpc[] = [];
let notifRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function initNotificationCenter(): void {
    const bell = document.getElementById('btn-notifications') as HTMLButtonElement | null;
    const popover = document.getElementById('notif-popover');
    const body = document.getElementById('notif-popover-body');
    const markAllBtn = document.getElementById('notif-mark-read');
    if (bell === null || popover === null || body === null) return;

    bell.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !popover.hidden;
        if (isOpen) {
            closeNotifPopover();
        } else {
            void openNotifPopover();
        }
    });

    if (markAllBtn !== null) {
        markAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            markAllNotificationsRead();
            void renderNotifications(body);
        });
    }

    // Click-away to close
    document.addEventListener('click', (e) => {
        if (popover.hidden) return;
        const target = e.target as Node;
        if (popover.contains(target) || bell.contains(target)) return;
        closeNotifPopover();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !popover.hidden) closeNotifPopover();
    });

    // Initial fetch so the badge is accurate at boot
    void refreshNotifBadge();
}

async function openNotifPopover(): Promise<void> {
    const bell = document.getElementById('btn-notifications');
    const popover = document.getElementById('notif-popover');
    const body = document.getElementById('notif-popover-body');
    if (bell === null || popover === null || body === null) return;
    popover.hidden = false;
    bell.setAttribute('aria-expanded', 'true');
    await renderNotifications(body);
    // Opening the popover means the user has seen the items — clear unread.
    markAllNotificationsRead();
    syncNotifBadge();
}

function closeNotifPopover(): void {
    const bell = document.getElementById('btn-notifications');
    const popover = document.getElementById('notif-popover');
    if (popover !== null) popover.hidden = true;
    if (bell !== null) bell.setAttribute('aria-expanded', 'false');
}

async function renderNotifications(host: HTMLElement): Promise<void> {
    try {
        const list = await kageOps.getNotifications();
        notifCache = list;
        const readIds = loadReadIds();
        const merged = list.map((n) => ({
            id: n.id,
            type: n.type,
            eventType: n.eventType,
            title: n.title,
            message: n.message,
            agent: n.agent,
            projectId: n.projectId,
            projectName: n.projectName,
            timestamp: n.timestamp,
            read: readIds.has(n.id),
        }));
        renderNotificationPanel(host, merged);
    } catch {
        host.innerHTML = '<div class="empty-state">Failed to load notifications</div>';
    }
}

async function refreshNotifBadge(): Promise<void> {
    try {
        const list = await kageOps.getNotifications();
        notifCache = list;
        syncNotifBadge();
    } catch {
        /* ignore — bell falls back to no badge */
    }
}

/** Debounced refresh used by live update hooks so a burst of
 *  events (approval + activity within ms) only triggers one fetch. */
function scheduleNotifRefresh(): void {
    if (notifRefreshTimer !== null) clearTimeout(notifRefreshTimer);
    notifRefreshTimer = setTimeout(() => {
        notifRefreshTimer = null;
        void refreshNotifBadge();
        const popover = document.getElementById('notif-popover');
        const body = document.getElementById('notif-popover-body');
        if (popover !== null && !popover.hidden && body !== null) {
            void renderNotifications(body);
        }
    }, NOTIF_REFRESH_DEBOUNCE_MS);
}

function syncNotifBadge(): void {
    const badge = document.getElementById('notif-bell-count');
    if (badge === null) return;
    const readIds = loadReadIds();
    const unread = notifCache.filter((n) => !readIds.has(n.id)).length;
    if (unread === 0) {
        badge.hidden = true;
        badge.textContent = '0';
    } else {
        badge.hidden = false;
        badge.textContent = unread > 99 ? '99+' : String(unread);
    }
}

function loadReadIds(): ReadonlySet<string> {
    try {
        const raw = localStorage.getItem(NOTIF_READ_KEY);
        if (raw === null) return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    } catch {
        return new Set();
    }
}

function markAllNotificationsRead(): void {
    const ids = notifCache.map((n) => n.id);
    try {
        const existing = loadReadIds();
        const merged = new Set<string>(existing);
        for (const id of ids) merged.add(id);
        // Cap at 500 to keep storage bounded
        const capped = Array.from(merged).slice(-500);
        localStorage.setItem(NOTIF_READ_KEY, JSON.stringify(capped));
    } catch { /* ignore */ }
}

// ── Collapsible Panels ──────────────────────────────

const PANEL_STATE_KEY = 'kageops_panel_state';

function initCollapsiblePanels(): void {
    // Restore saved collapse state
    const saved = loadPanelState();

    document.querySelectorAll<HTMLElement>('.panel[data-panel]').forEach((panel) => {
        const panelId = panel.dataset['panel'] ?? '';
        const header = panel.querySelector('.panel-header');
        if (header === null) return;

        // Restore saved state (but don't override HTML defaults for initially-collapsed panels)
        if (panelId in saved) {
            panel.classList.toggle('collapsed', saved[panelId]);
        }

        // Click header to toggle (but not when clicking buttons inside header)
        header.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('button') !== null || target.closest('.badge') !== null) return;
            panel.classList.toggle('collapsed');
            savePanelState();
        });
    });
}

function loadPanelState(): Record<string, boolean> {
    try {
        const raw = localStorage.getItem(PANEL_STATE_KEY);
        if (raw !== null) return JSON.parse(raw) as Record<string, boolean>;
    } catch { /* ignore */ }
    return {};
}

function savePanelState(): void {
    const state: Record<string, boolean> = {};
    document.querySelectorAll<HTMLElement>('.panel[data-panel]').forEach((panel) => {
        const id = panel.dataset['panel'] ?? '';
        if (id !== '') state[id] = panel.classList.contains('collapsed');
    });
    try { localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

// ── Operation Modes ─────────────────────────────────

type OperationMode = 'supervised' | 'autonomous' | 'chat-only';

const MODE_DESCRIPTIONS: Record<OperationMode, string> = {
    supervised: 'You approve before agents advance to each new phase',
    autonomous: 'Agents complete all phases without pausing for approval',
    'chat-only': 'Direct chat with Sensei — no agent tasks or projects',
};

let currentMode: OperationMode = 'supervised';

function initOperationModes(): void {
    const switcher = document.getElementById('mode-switcher');
    const descEl = document.getElementById('mode-desc');
    if (switcher === null) return;

    // Restore saved mode
    const saved = localStorage.getItem('kageops_operation_mode') as OperationMode | null;
    if (saved !== null && saved in MODE_DESCRIPTIONS) {
        currentMode = saved;
    }
    updateModeUI();

    switcher.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.mode-btn') as HTMLElement | null;
        if (btn === null) return;
        const mode = btn.dataset['mode'] as OperationMode | undefined;
        if (mode === undefined || mode === currentMode) return;
        currentMode = mode;
        localStorage.setItem('kageops_operation_mode', mode);
        updateModeUI();
    });

    function updateModeUI(): void {
        switcher!.querySelectorAll('.mode-btn').forEach((btn) => {
            const el = btn as HTMLElement;
            el.classList.toggle('active', el.dataset['mode'] === currentMode);
        });
        if (descEl !== null) descEl.textContent = MODE_DESCRIPTIONS[currentMode];
    }
}

// ── Permission Rules ────────────────────────────────

interface PermissionRule {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly defaultEnabled: boolean;
}

const PERMISSION_RULES: readonly PermissionRule[] = [
    { id: 'shell_exec', label: 'Shell Execution', description: 'Agents can run shell commands', defaultEnabled: true },
    { id: 'file_write', label: 'File Write', description: 'Agents can create and modify files', defaultEnabled: true },
    { id: 'file_delete', label: 'File Delete', description: 'Agents can delete project files', defaultEnabled: false },
    { id: 'git_push', label: 'Git Push', description: 'Agents can push to remote repos', defaultEnabled: false },
    { id: 'git_branch', label: 'Git Branch', description: 'Agents can create branches', defaultEnabled: true },
    { id: 'npm_install', label: 'NPM Install', description: 'Agents can install dependencies', defaultEnabled: true },
    { id: 'docker_exec', label: 'Docker Execute', description: 'Agents can run Docker commands', defaultEnabled: false },
    { id: 'api_calls', label: 'External API Calls', description: 'Agents can call external APIs', defaultEnabled: true },
    { id: 'db_migrate', label: 'Database Migrate', description: 'Agents can run DB migrations', defaultEnabled: false },
    { id: 'deploy', label: 'Deploy', description: 'Agents can trigger deployments', defaultEnabled: false },
];

const PERM_STATE_KEY = 'kageops_permissions';

function initPermissionsPanel(): void {
    const container = document.getElementById('permissions-body');
    if (container === null) return;

    const saved = loadPermissions();

    container.innerHTML = PERMISSION_RULES.map((rule) => {
        const enabled = rule.id in saved ? saved[rule.id] : rule.defaultEnabled;
        return `
            <div class="perm-row">
                <div class="perm-info">
                    <div class="perm-name">${rule.label}</div>
                    <div class="perm-desc">${rule.description}</div>
                </div>
                <label class="perm-toggle">
                    <input type="checkbox" data-perm="${rule.id}" ${enabled ? 'checked' : ''}>
                    <span class="perm-toggle-slider"></span>
                </label>
            </div>
        `;
    }).join('');

    // Wire toggle changes
    container.querySelectorAll<HTMLInputElement>('input[data-perm]').forEach((input) => {
        input.addEventListener('change', () => {
            savePermissions();
        });
    });
}

function loadPermissions(): Record<string, boolean> {
    try {
        const raw = localStorage.getItem(PERM_STATE_KEY);
        if (raw !== null) return JSON.parse(raw) as Record<string, boolean>;
    } catch { /* ignore */ }
    return {};
}

function savePermissions(): void {
    const state: Record<string, boolean> = {};
    document.querySelectorAll<HTMLInputElement>('input[data-perm]').forEach((input) => {
        const id = input.dataset['perm'] ?? '';
        if (id !== '') state[id] = input.checked;
    });
    try { localStorage.setItem(PERM_STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

// ── Layout Collapse (left sidebar + Sensei dock) ─────

function initLayoutCollapse(): void {
    const layout = document.getElementById('layout');
    if (layout === null) return;

    try {
        // Left sidebar defaults to open — only flip to closed if explicitly saved
        if (localStorage.getItem('kageops_left_open') === '0') {
            layout.setAttribute('data-left-open', 'false');
        }
    } catch { /* ignore */ }

    const collapseLeft = document.getElementById('collapse-left-btn');
    collapseLeft?.addEventListener('click', () => setLeftSidebarOpen(false));

    const openLeft = document.getElementById('open-left-tab');
    openLeft?.addEventListener('click', () => setLeftSidebarOpen(true));
}

function setLeftSidebarOpen(open: boolean): void {
    const layout = document.getElementById('layout');
    if (layout === null) return;
    layout.setAttribute('data-left-open', open ? 'true' : 'false');
    try {
        localStorage.setItem('kageops_left_open', open ? '1' : '0');
    } catch { /* ignore */ }
}

// ── Sidebar Resize ──────────────────────────────────

function initSidebarResize(): void {
    const layout = document.getElementById('layout');
    if (layout === null) return;

    // Restore saved widths
    const savedLeft = localStorage.getItem('kageops_sidebar_left_w');
    const savedRight = localStorage.getItem('kageops_sidebar_right_w');
    if (savedLeft !== null) layout.style.setProperty('--sidebar-left-width', savedLeft);
    if (savedRight !== null) layout.style.setProperty('--sidebar-right-width', savedRight);

    document.querySelectorAll<HTMLElement>('.sidebar-resize-handle').forEach((handle) => {
        let startX = 0;
        let startWidth = 0;
        const side = handle.dataset['sidebar'] ?? 'left';
        const sidebarId = side === 'left' ? 'sidebar-left' : 'sidebar-right';

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            const sidebar = document.getElementById(sidebarId);
            if (sidebar === null) return;
            startWidth = sidebar.getBoundingClientRect().width;
            handle.classList.add('dragging');

            const onMove = (ev: MouseEvent): void => {
                const delta = side === 'left'
                    ? ev.clientX - startX
                    : startX - ev.clientX;
                const newWidth = Math.max(180, Math.min(500, startWidth + delta));
                const prop = side === 'left' ? '--sidebar-left-width' : '--sidebar-right-width';
                layout!.style.setProperty(prop, `${newWidth}px`);
            };

            const onUp = (): void => {
                handle.classList.remove('dragging');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                // Persist
                const sidebar = document.getElementById(sidebarId);
                if (sidebar !== null) {
                    const key = side === 'left' ? 'kageops_sidebar_left_w' : 'kageops_sidebar_right_w';
                    const w = `${sidebar.getBoundingClientRect().width}px`;
                    localStorage.setItem(key, w);
                }
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

// ── Document Attachments (New Project Modal) ────────

interface PendingAttachment {
    readonly name: string;
    readonly size: number;
    readonly data: string;     // base64
    readonly mimeType: string;
}

let pendingAttachments: PendingAttachment[] = [];

function initDocAttachments(): void {
    const zone = document.getElementById('doc-attach-zone');
    const fileInput = document.getElementById('doc-attach-input') as HTMLInputElement | null;
    const listEl = document.getElementById('doc-attach-list');
    if (zone === null || fileInput === null || listEl === null) return;

    zone.addEventListener('click', () => fileInput.click());

    // Drag & drop
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; });
    zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.style.borderColor = '';
        if (e.dataTransfer?.files) {
            void processFiles(e.dataTransfer.files);
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files) {
            void processFiles(fileInput.files);
            fileInput.value = '';
        }
    });

    async function processFiles(files: FileList): Promise<void> {
        for (const file of Array.from(files)) {
            const data = await readFileAsBase64(file);
            pendingAttachments = [...pendingAttachments, {
                name: file.name,
                size: file.size,
                data,
                mimeType: file.type || 'application/octet-stream',
            }];
        }
        renderAttachments();
    }

    function renderAttachments(): void {
        if (listEl === null) return;
        listEl.innerHTML = pendingAttachments.map((att, i) => `
            <div class="doc-attach-item">
                <span>${icon('paperclip', { size: 14 })}</span>
                <span class="doc-attach-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
                <span class="doc-attach-size">${formatFileSize(att.size)}</span>
                <button class="doc-attach-remove" data-index="${i}" title="Remove">${icon('x', { size: 14 })}</button>
            </div>
        `).join('');

        listEl.querySelectorAll<HTMLButtonElement>('.doc-attach-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset['index'] ?? '0', 10);
                pendingAttachments = pendingAttachments.filter((_, j) => j !== idx);
                renderAttachments();
            });
        });
    }
}

function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            // Strip data:...;base64, prefix
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            resolve(base64);
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshAll(): Promise<void> {
    try {
        const projectsFilter = filterForTab(currentProjectTab);
        const [projects, agents, approvals] = await Promise.all([
            kageOps.listProjectsFiltered(projectsFilter).catch(() => kageOps.getProjects()),
            kageOps.getAgents(),
            kageOps.getApprovalQueue(),
        ]);

        renderProjects(projects);
        renderAgents(agents);
        renderApprovals(approvals);
    } catch {
        // Silently retry on next poll
    }

    // Refresh slow panels in parallel without blocking
    void refreshSlowPanels();
}

async function refreshCostPanel(): Promise<void> {
    try {
        const [operationalCosts, budgets, presets, agentModels] = await Promise.all([
            kageOps.getOperationalCosts(30).catch(() => null),
            kageOps.getRunBudgets().catch(() => [] as readonly RunBudgetEntry[]),
            kageOps.listPresets().catch(() => ({ presets: [], active: null as string | null })),
            kageOps.getAgentModelConfigs().catch(() => [] as AgentModelConfig[]),
        ]);
        const ciContainer = document.querySelector('#cost-intelligence-body') as HTMLElement | null;
        if (ciContainer !== null) {
            renderCostIntelligencePanel(
                ciContainer,
                operationalCosts,
                budgets,
                {
                    setProjectBudget: (id, cap) => kageOps.setProjectBudget(id, cap),
                    refresh: () => { void refreshCostPanel(); },
                },
                buildCostHeaderContext(presets.active, agentModels),
            );
            // PR-I (D-I): per-client cost roll-up + CSV export, appended
            // below the operational-spend view. renderCostIntelligencePanel
            // resets the body innerHTML each refresh, so re-mount our section
            // after it every time. Commercial only — the roll-up handler
            // (cost:get-client-rollup) lives in the commercial cost layer, so
            // skip it in the open build to avoid a "No handler registered" error.
            if (commercialUiAvailable) {
                try {
                    const ccSection = document.createElement('div');
                    ccSection.className = 'client-cost-section';
                    ciContainer.appendChild(ccSection);
                    renderClientCostPanel(ccSection, defaultClientCostPanelDeps());
                } catch {
                    // Per-client cost is additive — never block the cost view.
                }
            }
        }
    } catch {
        // Silently ignore
    }
}

/**
 * Build the "Models in use" header for Cost Intelligence. Detects
 * subscription mode (Claude CLI / Ollama) so the panel can explain
 * the $0 totals instead of looking broken.
 */
function buildCostHeaderContext(
    activePreset: string | null,
    agentModels: readonly AgentModelConfig[],
): import('./cost-intelligence-panel').CostHeaderContext {
    const SUBSCRIPTION_PROVIDERS = new Set(['claude-cli', 'codex', 'copilot', 'ollama', 'local']);
    const allSubscription = agentModels.length > 0
        && agentModels.every((m) => SUBSCRIPTION_PROVIDERS.has(m.provider.toLowerCase()));
    return {
        activePreset,
        agents: agentModels.map((m) => ({
            name: m.name,
            model: m.model,
            provider: m.provider,
        })),
        subscriptionMode: allSubscription,
        onOpenRouting: () => switchToView('model-routing'),
    };
}

async function refreshSlowPanels(): Promise<void> {
    try {
        const [operationalCosts, graphStatuses, graphifyProjects, systemStatus, buildsRaw, budgets, presets, agentModels] =
            await Promise.all([
                kageOps.getOperationalCosts(30).catch(() => null),
                kageOps.getGraphStatuses().catch(() => [] as CodeGraphStatus[]),
                kageOps.getGraphifyGraphs().catch(() => [] as GraphifyProjectEntry[]),
                kageOps.getSystemStatus().catch(() => null),
                kageOps.getBuilds().catch(() => [] as unknown[]),
                kageOps.getRunBudgets().catch(() => [] as readonly RunBudgetEntry[]),
                kageOps.listPresets().catch(() => ({ presets: [], active: null as string | null })),
                kageOps.getAgentModelConfigs().catch(() => [] as AgentModelConfig[]),
            ]);
        lastGraphifyProjects = graphifyProjects;

        const ciContainer = document.querySelector('#cost-intelligence-body') as HTMLElement | null;
        if (ciContainer !== null) {
            renderCostIntelligencePanel(
                ciContainer,
                operationalCosts,
                budgets,
                {
                    setProjectBudget: (id, cap) => kageOps.setProjectBudget(id, cap),
                    refresh: () => { void refreshCostPanel(); },
                },
                buildCostHeaderContext(presets.active, agentModels),
            );
        }

        const graphContainer = document.querySelector('#code-graph-body') as HTMLElement | null;
        if (graphContainer !== null) {
            // Skip re-render while a build is in progress — would clobber live log
            const anyBuilding = [...graphifyBuildState.values()].some((s) => s.status === 'building');
            if (!anyBuilding) {
                renderCodeGraphPanel(graphContainer, lastGraphifyProjects, graphifyBuildState, graphifyCallbacks);
            }
        }

        const statusContainer = document.querySelector('#status-bar-container') as HTMLElement | null;
        if (statusContainer !== null) {
            if (systemStatus !== null) {
                renderStatusBar(statusContainer, systemStatus);
            } else {
                renderStatusBarError(statusContainer);
            }
        }

        updateBootErrorBanner(systemStatus);

        const buildContainer = document.getElementById('build-status');
        if (buildContainer !== null) {
            renderBuildPanel(buildContainer, normalizeBuildRows(buildsRaw));
        }
    } catch {
        // Silently ignore
    }
}

/**
 * Map the raw snake_case rows returned by `command-center:get-builds` to
 * the camelCase `BuildEntry` shape `renderBuildPanel` expects. The IPC
 * layer returns Postgres rows verbatim — normalising here keeps the
 * renderer's type contract honest without forcing DB column renames.
 */
function normalizeBuildRows(rows: unknown): readonly BuildEntry[] {
    if (!Array.isArray(rows)) return [];
    const out: BuildEntry[] = [];
    for (const raw of rows) {
        if (typeof raw !== 'object' || raw === null) continue;
        const r = raw as Record<string, unknown>;
        const id = typeof r['id'] === 'string' ? r['id'] : '';
        if (id === '') continue;
        out.push({
            id,
            projectId: typeof r['project_id'] === 'string' ? r['project_id'] : '',
            pipeline: typeof r['pipeline'] === 'string' ? r['pipeline'] : 'unknown',
            runId: typeof r['run_id'] === 'string' ? r['run_id'] : null,
            status: typeof r['status'] === 'string' ? r['status'] : 'unknown',
            branch: typeof r['branch'] === 'string' ? r['branch'] : null,
            commitSha: typeof r['commit_sha'] === 'string' ? r['commit_sha'] : null,
            url: typeof r['url'] === 'string' ? r['url'] : null,
            logSummary: typeof r['log_summary'] === 'string' ? r['log_summary'] : null,
            startedAt: coerceIso(r['started_at']),
            completedAt: coerceIso(r['completed_at']),
        });
    }
    return out;
}

function coerceIso(v: unknown): string | null {
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return null;
}

// ── GitHub Panel ─────────────────────────────────────

function initGitHubPanel(): void {
    const container = document.querySelector('#github-settings-body') as HTMLElement | null;
    if (container === null) return;

    renderGitHubPanel(container, {
        getGitHubStatus: () => kageOps.getGitHubStatus(),
        setGitHubToken: (token) => kageOps.setGitHubToken(token),
        setProjectGitHub: (id, owner, repo) => kageOps.setProjectGitHub(id, owner, repo),
        getProjects: () => kageOps.getProjects(),
    });
}

// ── Model Routing Panel ───────────────────────────────

function initModelRoutingPanel(): void {
    const container = document.querySelector('#model-routing-body') as HTMLElement | null;
    if (container === null) return;

    renderModelRoutingPanel(container, {
        listPresets: () => kageOps.listPresets(),
        setActivePreset: (preset) => kageOps.setActivePreset(preset),
        listDesignProviders: () => kageOps.listDesignProviders(),
        setActiveDesignProvider: (providerId) => kageOps.setActiveDesignProvider(providerId),
        createPreset: (name, agents, overwrite) => kageOps.createPreset(name, agents, overwrite),
        deletePreset: (name) => kageOps.deletePreset(name),
        getPreset: (name) => kageOps.getPreset(name),
    });
}

// ── Deployments Panel — Azure Environments registry + Deploy Targets ──
//
// The Deployments tab hosts two stacked panels (D-H): the Azure
// Environments registry on top (PR-C — coordinates entered once, shared by
// Cloud Burst pools + deploy targets, D-A) and the Deploy Targets panel
// below (PR-G — register a target + one-click deploy a project to Azure).
// Each panel owns its own child container so neither clobbers the other on
// re-render.

function initDeploymentsPanel(): void {
    const container = document.querySelector('#deployments-body') as HTMLElement | null;
    if (container === null) return;
    container.innerHTML = '';
    const copilotRoot = document.createElement('div');
    const credRoot = document.createElement('div');
    const envRoot = document.createElement('div');
    const deployRoot = document.createElement('div');
    deployRoot.className = 'deploy-targets-section';
    container.appendChild(copilotRoot);
    container.appendChild(credRoot);
    container.appendChild(envRoot);
    container.appendChild(deployRoot);

    // PR-L: Sensei setup copilot discovery banner at the top — proposes the
    // next bounded setup step (renders nothing once setup is complete).
    try {
        renderSetupCopilotPanel(copilotRoot, defaultSetupCopilotPanelDeps());
    } catch {
        // Discovery is additive — never block the registry/deploy panels.
    }
    // MCC-8 Slice 4: app-credential ledger — appears when Sensei raises a
    // `setup.required` for a project mid-run, bound to that project.
    try {
        initAppCredentialLedger(credRoot);
    } catch {
        // Additive — never block the registry/deploy panels.
    }
    // BPF-6: toast the reason whenever a development-gate approval defers, so
    // clicking "Approve" never silently does nothing.
    try {
        initGateDeferredToast();
    } catch {
        // Additive — never block other panels.
    }
    try {
        renderAzureEnvironmentsPanel(envRoot, defaultAzureEnvironmentsPanelDeps());
    } catch (err) {
        envRoot.innerHTML = `<div class="empty-state">Azure Environments panel failed to load: ${err instanceof Error ? err.message : String(err)}</div>`;
    }
    try {
        renderDeployTargetsPanel(deployRoot, defaultDeployTargetsPanelDeps());
    } catch (err) {
        deployRoot.innerHTML = `<div class="empty-state">Deploy Targets panel failed to load: ${err instanceof Error ? err.message : String(err)}</div>`;
    }
}

/**
 * MCC-8 Slice 4: bind the app-credential ledger to whichever project most
 * recently raised a `setup.required`. The deployments tab is global (no
 * selected project), so the event's projectId drives which project's ledger
 * is shown; the panel then self-refreshes on subsequent events for it.
 */
let appCredentialLedger: AppCredentialPanelHandle | null = null;
let appCredentialLedgerProjectId: string | null = null;

function initAppCredentialLedger(root: HTMLElement): void {
    const onSetupRequired = (
        window as unknown as { kageOps?: { setup?: { onSetupRequired?: (cb: (e: unknown) => void) => () => void } } }
    ).kageOps?.setup?.onSetupRequired;
    if (onSetupRequired === undefined) return;

    onSetupRequired((event) => {
        const projectId = eventProjectId(event);
        if (projectId === null || projectId === appCredentialLedgerProjectId) return;
        appCredentialLedger?.dispose();
        appCredentialLedger = null;
        appCredentialLedgerProjectId = null;
        root.innerHTML = '';
        const panelRoot = document.createElement('div');
        root.appendChild(panelRoot);
        try {
            appCredentialLedger = renderAppCredentialPanel(panelRoot, defaultAppCredentialPanelDeps(projectId));
            appCredentialLedgerProjectId = projectId;
        } catch {
            root.innerHTML = '';
        }
    });
}

function eventProjectId(event: unknown): string | null {
    if (typeof event !== 'object' || event === null) return null;
    const pid = (event as Record<string, unknown>)['projectId'];
    return typeof pid === 'string' && pid !== '' ? pid : null;
}

/** BPF-6 — pull the human-readable defer message out of a gate.deferred event. */
function gateDeferredMessage(event: unknown): string | null {
    if (typeof event !== 'object' || event === null) return null;
    const data = (event as Record<string, unknown>)['data'];
    if (typeof data !== 'object' || data === null) return null;
    const msg = (data as Record<string, unknown>)['message'];
    return typeof msg === 'string' && msg !== '' ? msg : null;
}

/**
 * BPF-6 — subscribe to `gate.deferred` and surface the reason as a transient
 * toast. Without this, clicking "Approve" while the development exit gate is
 * holding (tasks in flight / build failing / deploy pending / credential
 * needed) looked like nothing happened — the #1 source of "it's stuck / we're
 * going in circles" confusion.
 */
function initGateDeferredToast(): void {
    const onGateDeferred = (
        window as unknown as {
            kageOps?: { setup?: { onGateDeferred?: (cb: (e: unknown) => void) => () => void } };
        }
    ).kageOps?.setup?.onGateDeferred;
    if (onGateDeferred === undefined) return;

    onGateDeferred((event) => {
        const message = gateDeferredMessage(event);
        if (message === null) return;
        showGateDeferredToast(message);
    });
}

let gateToastContainer: HTMLElement | null = null;

function showGateDeferredToast(message: string): void {
    if (gateToastContainer === null) {
        const c = document.createElement('div');
        c.className = 'gate-deferred-toast-stack';
        c.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:380px;';
        document.body.appendChild(c);
        gateToastContainer = c;
    }
    const toast = document.createElement('div');
    toast.className = 'gate-deferred-toast';
    toast.style.cssText =
        'background:#1a1a1a;border:1px solid #5BB377;border-left:3px solid #5BB377;border-radius:8px;' +
        'padding:12px 14px;color:#e8e8e8;font-size:13px;line-height:1.4;box-shadow:0 6px 24px rgba(0,0,0,0.4);' +
        'cursor:pointer;transition:opacity .3s;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;color:#5BB377;margin-bottom:3px;';
    title.textContent = 'Approval held';
    const body = document.createElement('div');
    body.textContent = message;
    toast.appendChild(title);
    toast.appendChild(body);
    const remove = (): void => {
        toast.style.opacity = '0';
        window.setTimeout(() => toast.remove(), 300);
    };
    toast.addEventListener('click', remove);
    gateToastContainer.appendChild(toast);
    window.setTimeout(remove, 9000);
}

// ── Cloud Burst Panel (Pillar 2.4 / PR-F.next + PR-G.next) ──

function initCloudBurstPanel(): void {
    registerViewInit('cloud-burst', () => {
        const container = document.querySelector('#view-cloud-burst') as HTMLElement | null;
        if (container === null) return;
        try {
            const deps = defaultCloudBurstPanelDeps();
            renderCloudBurstPanel(container, deps);
        } catch (err) {
            container.innerHTML = `<div class="empty-state">Cloud Burst panel failed to load: ${err instanceof Error ? err.message : String(err)}</div>`;
        }
    });
}

// ── APO Rollback Panel (B-478) ───────────────────────

function initApoRollbackPanel(): void {
    const container = document.querySelector('#apo-rollback-body') as HTMLElement | null;
    if (container === null) return;

    const callbacks: ApoRollbackPanelCallbacks = {
        listApoBackups: () => kageOps.listApoBackups(),
        restoreApoBackup: (backupPath) => kageOps.restoreApoBackup(backupPath),
    };

    renderApoRollbackPanel(container, callbacks);
}

// ── APO History / Diff Panel (v0.11) ──────────────────

function initApoHistoryPanel(): void {
    const container = document.querySelector('#apo-history-body') as HTMLElement | null;
    if (container === null) return;

    const callbacks: ApoHistoryCallbacks = {
        list: () => kageOps.listPromptOptimizations(),
        accept: (id) => kageOps.acceptPromptOptimization(id),
        reject: (id) => kageOps.rejectPromptOptimization(id),
    };

    renderApoHistoryPanel(container, callbacks);
}

// ── Team Members Panel ────────────────────────────────

function initTeamMembersPanel(): void {
    const container = document.querySelector('#team-members-body') as HTMLElement | null;
    if (container === null) return;
    renderTeamMembersPanel(container, {
        getTeamMembers: () => kageOps.getTeamMembers() as Promise<any[]>,
        addTeamMember: (n, e, r) => kageOps.addTeamMember(n, e, r) as Promise<any>,
        removeTeamMember: (id) => kageOps.removeTeamMember(id) as Promise<any>,
        inviteMember: (email, role) => kageOps.teamInviteMember(email, role) as Promise<any>,
        updateMemberRole: (memberId, role) => kageOps.teamUpdateRole(memberId, role) as Promise<any>,
        getProjectAssignments: () => kageOps.teamGetProjectAssignments() as Promise<any[]>,
        assignToProject: (projectId, userId, userName, userEmail, role) =>
            kageOps.teamAssignToProject(projectId, userId, userName, userEmail, role) as Promise<any>,
        removeAssignment: (assignmentId) => kageOps.teamRemoveAssignment(assignmentId) as Promise<any>,
        getActivityFeed: (filter) => kageOps.teamGetActivityFeed(filter) as Promise<any[]>,
        onPresenceUpdate: (handler) => kageOps.onPresenceUpdate(handler as (state: unknown) => void),
    });
}

// ── Agent Management Panel ────────────────────────────

function initAgentManagementPanel(): void {
    const container = document.querySelector('#agent-management-body') as HTMLElement | null;
    if (container === null) return;
    renderAgentManagementPanel(container, {
        getAgentConfigs: () => kageOps.getAgentConfigs() as Promise<AgentConfig[]>,
        setAgentEnabled: (name, enabled) => kageOps.setAgentEnabled(name, enabled) as Promise<{ success: boolean; error?: string }>,
        onAgentClick: (name) => openAgentDetailPanel(name),
    });
}

// ── Helper Functions ─────────────────────────────────

function getPhaseBadgeClass(phase: string): string {
    const p = phase.toLowerCase();
    if (p.includes('development') || p.includes('launch')) return 'badge-green';
    if (p.includes('poc') || p.includes('business') || p.includes('viability')) return 'badge-yellow';
    if (p.includes('discovery') || p.includes('design') || p.includes('planning')) return 'badge-blue';
    if (p.includes('fail') || p.includes('error')) return 'badge-red';
    return 'badge-gray';
}

function getActivitySeverityClass(message: string): string {
    const m = message.toLowerCase();
    if (m.includes('error') || m.includes('failed')) return 'activity-item--error';
    if (m.includes('warning') || m.includes('warn')) return 'activity-item--warn';
    if (m.includes('passed') || m.includes('complete') || m.includes('success') || m.includes('ready')) return 'activity-item--success';
    return '';
}

// ── Code Graph Panel ─────────────────────────────────

const graphifyBuildState = new Map<string, GraphifyBuildState>();
let lastGraphifyProjects: readonly GraphifyProjectEntry[] = [];

const graphifyCallbacks: CodeGraphCallbacks = {
    onBuild: (projectId, repoPath) => {
        graphifyBuildState.set(projectId, { status: 'building', log: [] });
        void kageOps.runGraphify(projectId, repoPath).catch((err: unknown) => {
            graphifyBuildState.set(projectId, {
                status: 'error',
                log: [`Failed to start: ${err instanceof Error ? err.message : String(err)}`],
            });
        });
    },
    onOpen: (htmlPath) => {
        const container = document.querySelector<HTMLElement>('#code-graph-body');
        if (container === null) return;
        const project = lastGraphifyProjects.find(
            (p) => (p.htmlPath === htmlPath) ||
                   htmlPath.startsWith(p.repoPath.replace(/\\/g, '/')) ||
                   htmlPath.startsWith(p.repoPath)
        );
        const name = project?.projectName ?? 'Knowledge Graph';
        const projectId = project?.projectId ?? '';
        // v0.1.34: pass the artifact-read IPC through to the viewer so the
        // side pane can fetch source for a clicked node.
        const readFile = async (
            pid: string,
            relPath: string,
        ): Promise<{ ok: boolean; content: string | null; error?: string }> => {
            try {
                const res = await kageOps.readArtifact(pid, relPath) as {
                    success: boolean;
                    preview?: { content?: string; truncated?: boolean };
                    error?: string;
                };
                if (res.success && res.preview?.content !== undefined) {
                    return { ok: true, content: res.preview.content };
                }
                return { ok: false, content: null, error: res.error ?? 'Not readable' };
            } catch (err) {
                return { ok: false, content: null, error: err instanceof Error ? err.message : String(err) };
            }
        };
        // Pre-fetch through main so we can detect missing/empty graph.html and
        // render an inline error instead of a blank iframe. The viewer treats
        // anything shorter than 200 chars as "not a real graph".
        void kageOps.readGraphHtml(htmlPath).then((res) => {
            const probe = res.ok ? (res.content ?? '').slice(0, 200) : '';
            showGraphInViewer(container, htmlPath, name, probe, projectId, readFile);
        }).catch(() => {
            showGraphInViewer(container, htmlPath, name, '<!-- read failed -->', projectId, readFile);
        });
    },
};

function initCodeGraphPanel(): void {
    kageOps.onGraphifyProgress((event) => {
        // Update in-memory state
        const existing = graphifyBuildState.get(event.projectId);
        const newLog = [...(existing?.log ?? []), event.line];
        const newStatus: GraphifyBuildState['status'] = event.done
            ? (event.error !== null ? 'error' : 'done')
            : 'building';
        graphifyBuildState.set(event.projectId, { status: newStatus, log: newLog });

        // Incremental DOM update — no full re-render
        const container = document.querySelector<HTMLElement>('#code-graph-body');
        if (container !== null) {
            updateGraphifyBuildProgress(container, event, graphifyCallbacks);
        }

        // After successful build, refresh the project list to get updated stats
        if (event.done && event.error === null) {
            void kageOps.getGraphifyGraphs()
                .then((projects) => { lastGraphifyProjects = projects; })
                .catch(() => { /* ignore */ });
        }
    });
}

// ── Projects Panel ───────────────────────────────────

let currentProjectTab: ProjectTab = 'active';
let lastFetchedProjects: ProjectInfo[] = [];
let projectSearchQuery: string = '';
let projectStatusFilter: string = '';
let projectPhaseFilter: string = '';

function initProjectsPanel(): void {
    const tabs = document.getElementById('projects-tabs');
    if (tabs !== null) {
        tabs.querySelectorAll<HTMLButtonElement>('.projects-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = (btn.dataset['tab'] ?? 'active') as ProjectTab;
                setProjectTab(tab);
            });
        });
    }

    const searchInput = document.getElementById('projects-search') as HTMLInputElement | null;
    if (searchInput !== null) {
        searchInput.addEventListener('input', () => {
            projectSearchQuery = searchInput.value;
            renderProjects(lastFetchedProjects);
        });
    }

    const statusSelect = document.getElementById('projects-status-filter') as HTMLSelectElement | null;
    if (statusSelect !== null) {
        statusSelect.addEventListener('change', () => {
            projectStatusFilter = statusSelect.value;
            renderProjects(lastFetchedProjects);
        });
    }

    const phaseSelect = document.getElementById('projects-phase-filter') as HTMLSelectElement | null;
    if (phaseSelect !== null) {
        phaseSelect.addEventListener('change', () => {
            projectPhaseFilter = phaseSelect.value;
            renderProjects(lastFetchedProjects);
        });
    }

    const clearBtn = document.getElementById('projects-clear-filters');
    if (clearBtn !== null) {
        clearBtn.addEventListener('click', () => {
            projectSearchQuery = '';
            projectStatusFilter = '';
            projectPhaseFilter = '';
            if (searchInput !== null) searchInput.value = '';
            if (statusSelect !== null) statusSelect.value = '';
            if (phaseSelect !== null) phaseSelect.value = '';
            renderProjects(lastFetchedProjects);
        });
    }
}

function setProjectTab(tab: ProjectTab): void {
    currentProjectTab = tab;
    const tabs = document.getElementById('projects-tabs');
    if (tabs !== null) {
        tabs.querySelectorAll<HTMLButtonElement>('.projects-tab').forEach((btn) => {
            const active = btn.dataset['tab'] === tab;
            btn.classList.toggle('projects-tab--active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }
    void refreshProjectsForTab();
}

async function refreshProjectsForTab(): Promise<void> {
    const filter = filterForTab(currentProjectTab);
    try {
        const projects = await kageOps.listProjectsFiltered(filter);
        lastFetchedProjects = projects;
        renderProjects(projects);
    } catch {
        lastFetchedProjects = [];
        renderProjects([]);
    }
}

function refreshFilterDropdowns(projects: ProjectInfo[]): void {
    const statusSelect = document.getElementById('projects-status-filter') as HTMLSelectElement | null;
    const phaseSelect = document.getElementById('projects-phase-filter') as HTMLSelectElement | null;
    if (statusSelect !== null) {
        const statuses = uniqueSorted(projects, 'status');
        const current = statusSelect.value;
        statusSelect.innerHTML = '<option value="">All statuses</option>' +
            statuses.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
        if (statuses.includes(current)) {
            statusSelect.value = current;
        } else {
            projectStatusFilter = '';
        }
    }
    if (phaseSelect !== null) {
        const phases = uniqueSorted(projects, 'phase');
        const current = phaseSelect.value;
        phaseSelect.innerHTML = '<option value="">All phases</option>' +
            phases.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
        if (phases.includes(current)) {
            phaseSelect.value = current;
        } else {
            projectPhaseFilter = '';
        }
    }
}

function renderFilterCount(matched: number, total: number): void {
    const el = document.getElementById('projects-filter-count');
    if (el === null) return;
    const hasFilter = projectSearchQuery.trim() !== '' || projectStatusFilter !== '' || projectPhaseFilter !== '';
    el.textContent = hasFilter ? `${matched} of ${total}` : '';
}

function filterForTab(tab: ProjectTab): { include?: readonly string[]; exclude?: readonly string[] } {
    switch (tab) {
        // `awaiting-input` (F-368) — reopened-but-no-work-yet — lives in the
        // Active tab. It's actionable (the operator can add a follow-up brief
        // or close it), but it has no pending Forge work.
        case 'active':    return { include: ['active', 'paused', 'awaiting-approval', 'awaiting-input'] };
        case 'completed': return { include: ['completed', 'cancelled'] };
        case 'archived':  return { include: ['archived'] };
    }
}

function actionsForStatus(status: string): readonly { label: string; action: string; danger?: boolean }[] {
    // Delete is offered on every status — the handler asks the user to type
    // the project name to confirm, so the safety gate stays. Useful when you
    // create a project by mistake and don't want to archive-then-delete.
    const DELETE = { label: 'Delete\u2026', action: 'delete', danger: true };
    const RESTART = { label: 'Restart', action: 'restart' };
    switch (status) {
        case 'active':
            return [
                RESTART,
                { label: 'Pause', action: 'pause' },
                { label: 'Cancel', action: 'cancel', danger: true },
                DELETE,
            ];
        case 'paused':
            return [
                { label: 'Resume', action: 'resume' },
                RESTART,
                { label: 'Cancel', action: 'cancel', danger: true },
                DELETE,
            ];
        case 'awaiting-approval':
            return [
                RESTART,
                { label: 'Cancel', action: 'cancel', danger: true },
                DELETE,
            ];
        // F-368: reopened from completed, no new work decomposed yet. Operator
        // can close it back to completed, archive it, or (future F-342) add a
        // follow-up brief. "Reopen" is not offered because the project is
        // already reopened.
        case 'awaiting-input':
            return [
                { label: 'Close', action: 'close' },
                { label: 'Archive', action: 'archive' },
                DELETE,
            ];
        case 'completed':
        case 'cancelled':
            return [
                { label: 'Reopen', action: 'reopen' },
                { label: 'Archive', action: 'archive' },
                DELETE,
            ];
        case 'archived':
            return [
                { label: 'Reopen', action: 'reopen' },
                { label: 'Restore', action: 'restore' },
                DELETE,
            ];
        default:
            return [DELETE];
    }
}

function statusBadgeClass(status: string): string {
    const slug = status.replace(/[^a-z-]/gi, '').toLowerCase();
    return `project-status-badge project-status-badge--${slug}`;
}

function renderProjects(projects: ProjectInfo[]): void {
    const container = $('#projects-list');
    if (container === null) return;

    // Cache the most-recently-updated active project's phase so the
    // Orchestration Flow phase strip can highlight it instead of being
    // a static decorative banner.
    const activePhaseProject = projects.find((p) => p.status === 'active' || p.status === 'paused' || p.status === 'awaiting-approval' || p.status === 'awaiting-input');
    cachedActivePhase = activePhaseProject?.phase ?? null;

    refreshFilterDropdowns(projects);
    const filtered = applyProjectFilter(projects, {
        search: projectSearchQuery,
        status: projectStatusFilter,
        phase: projectPhaseFilter,
    });
    renderFilterCount(filtered.length, projects.length);

    if (projects.length === 0) {
        const empty = currentProjectTab === 'archived'
            ? 'No archived projects'
            : currentProjectTab === 'completed'
                ? 'No completed projects'
                : 'No active projects';
        container.innerHTML = `<div class="empty-state">${empty}<div id="empty-state-hint" class="empty-state-hint"></div></div>`;
        // Async hint: count projects on the other tabs so the user can find their work
        void (async (): Promise<void> => {
            try {
                const allCompleted = await kageOps.listProjectsFiltered({ include: ['completed', 'cancelled'] });
                const allArchived  = await kageOps.listProjectsFiltered({ include: ['archived'] });
                const hints: string[] = [];
                if (currentProjectTab !== 'completed' && allCompleted.length > 0) {
                    hints.push(`<a href="#" data-switch-tab="completed">${allCompleted.length} completed</a>`);
                }
                if (currentProjectTab !== 'archived' && allArchived.length > 0) {
                    hints.push(`<a href="#" data-switch-tab="archived">${allArchived.length} archived</a>`);
                }
                const hintEl = document.getElementById('empty-state-hint');
                if (hintEl !== null && hints.length > 0) {
                    hintEl.innerHTML = `Try the ${hints.join(' or ')} tab.`;
                    hintEl.querySelectorAll<HTMLAnchorElement>('a[data-switch-tab]').forEach((a) => {
                        a.addEventListener('click', (ev) => {
                            ev.preventDefault();
                            const next = a.dataset['switchTab'] as ProjectTab | undefined;
                            if (next !== undefined) setProjectTab(next);
                        });
                    });
                }
            } catch { /* best-effort hint */ }
        })();
        return;
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state">No projects match your search or filters</div>`;
        return;
    }

    container.innerHTML = filtered.map((p) => {
        const progress = p.taskCounts.total > 0
            ? Math.round((p.taskCounts.completed / p.taskCounts.total) * 100)
            : 0;

        const badgeClass = getPhaseBadgeClass(p.phase);
        const statusActions = actionsForStatus(p.status);
        const retriable = p.taskCounts.failed > 0 && p.status !== 'archived' && p.status !== 'completed';
        const allActions: readonly { label: string; action: string; danger?: boolean }[] = retriable
            ? [{ label: `Retry ${p.taskCounts.failed} failed`, action: 'retry-failed' }, ...statusActions]
            : statusActions;
        const actions = allActions.map((a) =>
            `<button class="project-action-btn${a.danger ? ' project-action-btn--danger' : ''}" data-action="${a.action}" data-id="${p.id}" data-name="${escapeHtml(p.name)}">${a.label}</button>`
        ).join('');

        return `
            <div class="project-card project-card--clickable" data-id="${p.id}" data-name="${escapeHtml(p.name)}" title="Click to view tasks">
                <div class="project-name">
                    <span class="project-name-text">${escapeHtml(p.name)}</span>
                    <button class="btn-edit" data-id="${p.id}" data-name="${escapeHtml(p.name)}" title="Edit name, description, trust level"><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 1.5 10.5 3.5 4 10H2v-2z"/><line x1="7" y1="3" x2="9" y2="5"/></svg></button>
                </div>
                <div class="project-meta">
                    <span class="${badgeClass}">${escapeHtml(p.phase)}</span>
                    <span class="${statusBadgeClass(p.status)}">${escapeHtml(p.status)}</span>
                    ${(p.reopenCount ?? 0) > 0 ? `<button class="iteration-badge" data-id="${p.id}" data-name="${escapeHtml(p.name)}" title="View iteration history"><svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6 a4 4 0 1 0 4 -4"/><polyline points="2 2 2 6 6 6"/></svg> iteration ${p.reopenCount}</button>` : ''}
                    <button class="btn-graph" data-id="${p.id}" data-name="${escapeHtml(p.name)}" title="Phase Graph"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="2.5" r="1.5"/><circle cx="2.5" cy="9" r="1.5"/><circle cx="9.5" cy="9" r="1.5"/><line x1="6" y1="4" x2="3.2" y2="7.6"/><line x1="6" y1="4" x2="8.8" y2="7.6"/></svg></button>
                    <button class="btn-docs" data-id="${p.id}" data-name="${escapeHtml(p.name)}" title="Upload documents"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 1h5.5L10 3.5V11H2V1z"/><path d="M7 1v3h3"/><line x1="4" y1="6" x2="8" y2="6"/><line x1="4" y1="8" x2="7" y2="8"/></svg></button>
                    <button class="btn-artifacts" data-id="${p.id}" data-name="${escapeHtml(p.name)}" title="Browse artifacts"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 3h4l1 1.5h5v5.5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3Z"/></svg></button>
                </div>
                <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
                <div class="task-count">${p.taskCounts.completed}/${p.taskCounts.total} tasks</div>
                ${actions === '' ? '' : `<div class="project-actions">${actions}</div>`}
            </div>
        `;
    }).join('');

    // Wire card click → task output panel (exclude action buttons)
    container.querySelectorAll<HTMLElement>('.project-card--clickable').forEach((card) => {
        card.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.btn-docs') !== null) return;
            if (target.closest('.btn-graph') !== null) return;
            if (target.closest('.btn-artifacts') !== null) return;
            if (target.closest('.btn-edit') !== null) return;
            if (target.closest('.iteration-badge') !== null) return;
            if (target.closest('.project-action-btn') !== null) return;
            const projectId = card.dataset['id'] ?? '';
            const projectName = card.dataset['name'] ?? '';
            openTaskOutputPanel(projectId, projectName);
        });
    });

    // P1-05b: iteration badge → opens history side-panel
    container.querySelectorAll<HTMLButtonElement>('.iteration-badge').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = btn.dataset['id'] ?? '';
            const projectName = btn.dataset['name'] ?? '';
            if (projectId !== '') {
                void openIterationHistoryPanel(projectId, projectName);
            }
        });
    });

    container.querySelectorAll<HTMLButtonElement>('.btn-edit').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = btn.dataset['id'] ?? '';
            const projectName = btn.dataset['name'] ?? '';
            if (projectId !== '') {
                void handleEditProjectMetadata(projectId, projectName);
            }
        });
    });

    // Wire graph buttons
    container.querySelectorAll<HTMLButtonElement>('.btn-graph').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = btn.dataset['id'] ?? '';
            const projectName = btn.dataset['name'] ?? '';
            if (projectId !== '') openPhaseGraphPanel(projectId, projectName);
        });
    });

    // Wire docs buttons
    container.querySelectorAll<HTMLButtonElement>('.btn-docs').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = btn.dataset['id'] ?? '';
            const projectName = btn.dataset['name'] ?? '';
            if (projectId !== '') openDocumentUploadPanel(projectId, projectName);
        });
    });

    // Wire artifacts buttons
    container.querySelectorAll<HTMLButtonElement>('.btn-artifacts').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const projectId = btn.dataset['id'] ?? '';
            const projectName = btn.dataset['name'] ?? '';
            if (projectId !== '') openArtifactBrowserPanel(projectId, projectName);
        });
    });

    // Wire lifecycle action buttons
    container.querySelectorAll<HTMLButtonElement>('.project-action-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset['action'] ?? '';
            const projectId = btn.dataset['id'] ?? '';
            const projectName = btn.dataset['name'] ?? '';
            void handleProjectAction(action, projectId, projectName);
        });
    });
}

async function handleProjectAction(action: string, projectId: string, projectName: string): Promise<void> {
    if (projectId === '' || action === '') return;

    type LifecycleRes = {
        success: boolean;
        error?: string;
        changed?: boolean;
        status?: string;
        fromStatus?: string;
    };
    let res: LifecycleRes | undefined;

    if (action === 'cancel') {
        if (!window.confirm(`Cancel "${projectName}"? In-flight tasks will stop.`)) return;
        res = await kageOps.cancelProject(projectId, 'user-cancelled') as LifecycleRes;
    } else if (action === 'pause') {
        res = await kageOps.pauseProject(projectId) as LifecycleRes;
    } else if (action === 'resume') {
        res = await kageOps.resumeProject(projectId) as LifecycleRes;
    } else if (action === 'archive') {
        res = await kageOps.archiveProject(projectId) as LifecycleRes;
    } else if (action === 'restore') {
        res = await kageOps.restoreProject(projectId) as LifecycleRes;
    } else if (action === 'reopen') {
        if (!window.confirm(
            `Reopen "${projectName}"?\n\nThis flips the project back to active so Sensei can dispatch new tasks. Existing tasks and their outputs are preserved.`
        )) return;
        res = await kageOps.reopenProject(projectId) as LifecycleRes;
        if (res.success === true && res.changed !== false) {
            showProjectRunToast(
                'Reopened',
                `"${projectName}" is now active. Use the chat or "Restart" to dispatch new work.`,
            );
        }
    } else if (action === 'delete') {
        // Two-step confirm: Electron's renderer disables window.prompt(),
        // so the previous "type the name to confirm" UX silently failed.
        // Use confirm() (which Electron supports) twice for the same safety.
        if (!window.confirm(
            `Delete "${projectName}"?\n\nThis removes the project from the database AND deletes the workspace directory on disk. Cannot be undone.`
        )) return;
        if (!window.confirm(
            `Final check — are you SURE you want to permanently delete "${projectName}"?`
        )) return;
        res = await kageOps.deleteProject(projectId) as LifecycleRes;
    } else if (action === 'retry-failed') {
        const retryRes = await kageOps.retryFailedTasks(projectId);
        if (retryRes.success && typeof retryRes.retried === 'number' && retryRes.retried > 0) {
            showProjectRunToast(
                'Retry scheduled',
                `Re-dispatching ${retryRes.retried} failed task${retryRes.retried === 1 ? '' : 's'} on "${projectName}".`,
            );
        } else if (!retryRes.success) {
            showProjectRunToast('Retry failed', retryRes.error ?? 'unknown error');
        }
        await refreshProjectsForTab();
        return;
    } else if (action === 'restart') {
        if (!window.confirm(
            `Restart "${projectName}"?\n\nAny tasks that look stalled (assigned/in-progress) will be re-queued and dispatched again. Use this after an app restart, network drop, or if the run is stuck in "thinking…".`
        )) return;
        const restartRes = await kageOps.restartProject(projectId);
        if (restartRes.success) {
            const n = restartRes.requeued ?? 0;
            showProjectRunToast(
                'Restart scheduled',
                n > 0
                    ? `Re-dispatched ${n} stalled task${n === 1 ? '' : 's'} on "${projectName}".`
                    : `"${projectName}" woken up — no stalled tasks found.`,
            );
        } else {
            showProjectRunToast('Restart failed', restartRes.error ?? 'unknown error');
        }
        await refreshProjectsForTab();
        return;
    }

    if (res !== undefined) {
        // PR D of F-302 — surface optimistic-lock conflicts (PR C) with a
        // distinct toast that points the operator at the refresh action,
        // rather than the generic "failed" copy. The conflict envelope sets
        // `conflict: true` alongside `success: false`.
        const conflictRes = res as LifecycleRes & { conflict?: true };
        if (conflictRes.success === false && conflictRes.conflict === true) {
            showProjectRunToast(
                `Couldn't ${action.toLowerCase()} — out of date`,
                `Another team member updated "${projectName}" just now. Refreshing the project list.`,
            );
        } else if (!res.success) {
            showProjectRunToast(
                `${actionLabel(action)} failed`,
                res.error ?? 'unknown error',
            );
        } else if (res.changed === false && action !== 'delete') {
            const current = res.status ?? res.fromStatus ?? 'unknown';
            showProjectRunToast(
                `${actionLabel(action)} — no change`,
                `"${projectName}" is ${current}; ${action} is not available from this state.`,
            );
        }
    }
    await refreshProjectsForTab();
}

function actionLabel(action: string): string {
    switch (action) {
        case 'cancel': return 'Cancel';
        case 'pause': return 'Pause';
        case 'resume': return 'Resume';
        case 'restart': return 'Restart';
        case 'archive': return 'Archive';
        case 'restore': return 'Restore';
        case 'reopen': return 'Reopen';
        case 'delete': return 'Delete';
        default: return action;
    }
}

/**
 * Inline edit of project name/description/trust_level (B-406).
 * Uses the shared float overlay for a simple three-field form.
 */
async function handleEditProjectMetadata(projectId: string, projectNameHint: string): Promise<void> {
    const existing = await kageOps.getProjectMetadata(projectId);
    if (!existing.success || existing.metadata === undefined) {
        window.alert(`Failed to load project: ${existing.error ?? 'unknown error'}`);
        return;
    }
    const body = openFloatOverlay(`Edit — ${projectNameHint}`);
    const current = existing.metadata;
    body.innerHTML = `
        <div class="project-edit-form">
            <label class="project-edit-field">
                <span>Name</span>
                <input type="text" data-role="name" maxlength="200" value="${escapeHtml(current.name)}">
            </label>
            <label class="project-edit-field">
                <span>Description</span>
                <textarea data-role="description" rows="6">${escapeHtml(current.description)}</textarea>
            </label>
            <label class="project-edit-field">
                <span>Trust level</span>
                <select data-role="trust">
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                </select>
            </label>
            <div class="project-edit-actions">
                <button data-role="cancel" class="btn-secondary">Cancel</button>
                <button data-role="save" class="btn-primary">Save</button>
            </div>
            <div class="project-edit-status" data-role="status"></div>
        </div>
    `;
    const nameInput = body.querySelector<HTMLInputElement>('[data-role="name"]');
    const descInput = body.querySelector<HTMLTextAreaElement>('[data-role="description"]');
    const trustSelect = body.querySelector<HTMLSelectElement>('[data-role="trust"]');
    const statusEl = body.querySelector<HTMLElement>('[data-role="status"]');
    if (nameInput === null || descInput === null || trustSelect === null || statusEl === null) return;
    trustSelect.value = current.trustLevel;

    const cancelBtn = body.querySelector<HTMLButtonElement>('[data-role="cancel"]');
    const saveBtn = body.querySelector<HTMLButtonElement>('[data-role="save"]');
    if (cancelBtn !== null) cancelBtn.addEventListener('click', () => closeFloatOverlay());
    if (saveBtn !== null) {
        saveBtn.addEventListener('click', () => {
            void submitEdit(projectId, nameInput, descInput, trustSelect, saveBtn, statusEl, current);
        });
    }
}

async function submitEdit(
    projectId: string,
    nameInput: HTMLInputElement,
    descInput: HTMLTextAreaElement,
    trustSelect: HTMLSelectElement,
    saveBtn: HTMLButtonElement,
    statusEl: HTMLElement,
    current: { name: string; description: string; trustLevel: 'low' | 'medium' | 'high' },
): Promise<void> {
    const updates: { name?: string; description?: string; trustLevel?: 'low' | 'medium' | 'high' } = {};
    const newName = nameInput.value.trim();
    if (newName !== current.name) updates.name = newName;
    if (descInput.value !== current.description) updates.description = descInput.value;
    const trustRaw = trustSelect.value;
    if ((trustRaw === 'low' || trustRaw === 'medium' || trustRaw === 'high') && trustRaw !== current.trustLevel) {
        updates.trustLevel = trustRaw;
    }
    if (Object.keys(updates).length === 0) {
        closeFloatOverlay();
        return;
    }
    saveBtn.disabled = true;
    statusEl.textContent = 'Saving…';
    try {
        const res = await kageOps.updateProjectMetadata(projectId, updates);
        if (!res.success) {
            statusEl.textContent = res.error ?? 'Update failed';
            saveBtn.disabled = false;
            return;
        }
        closeFloatOverlay();
        await refreshProjectsForTab();
    } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : 'Update failed';
        saveBtn.disabled = false;
    }
}

// ── Agents Panel ─────────────────────────────────────

function initAgentsPanel(): void {
    // Rendered by renderAgents
}

function renderAgents(agents: AgentInfo[]): void {
    // Cache for orchestration flow graph
    cachedAgentStates = agents.map(a => ({
        name: a.name,
        status: a.status,
        currentTask: a.currentTaskTitle,
    }));

    const container = $('#agents-list');
    if (container === null) return;

    if (agents.length === 0) {
        container.innerHTML = '<div class="empty-state">No agents registered</div>';
        return;
    }

    // Fetch enable/disable state to show toggles
    void kageOps.getAgentConfigs().then((configs) => {
        const enabledMap = new Map(configs.map((c) => [c.name.toLowerCase(), c.enabled]));
        renderAgentRows(container, agents, enabledMap);
    }).catch(() => {
        renderAgentRows(container, agents, new Map());
    });
}

function renderAgentRows(
    container: HTMLElement,
    agents: AgentInfo[],
    enabledMap: ReadonlyMap<string, boolean>
): void {
    container.innerHTML = agents.map((a) => {
        const enabled = enabledMap.get(a.name.toLowerCase()) ?? true;
        const modelShort = a.model && a.model.length > 28 ? a.model.slice(0, 25) + '\u2026' : (a.model ?? '');
        return `
        <div class="agent-row agent-row--clickable ${enabled ? '' : 'agent-row--disabled'}" data-agent="${escapeHtml(a.name)}">
            <div class="agent-avatar-wrap">
                <span class="agent-avatar sigil-host">${getSigilHtml(a.name.toLowerCase(), { label: a.name })}</span>
                <div class="status-dot status-dot--overlay ${a.status}"></div>
            </div>
            <div class="agent-identity">
                <span class="agent-name">${escapeHtml(a.name)}</span>
                ${a.role ? `<span class="agent-role">${escapeHtml(a.role)}</span>` : ''}
            </div>
            <div class="agent-info">
                <span class="agent-task">${a.currentTaskTitle ? escapeHtml(a.currentTaskTitle) : 'Idle'}</span>
                ${a.status === 'busy' ? `<span class="agent-thinking-text" data-agent="${escapeHtml(a.name)}"></span>` : ''}
                ${modelShort ? `<span class="agent-model" title="${escapeHtml(a.model ?? '')}">${escapeHtml(modelShort)}</span>` : ''}
            </div>
            <label class="agent-toggle agent-toggle--sidebar" title="${enabled ? 'Enabled' : 'Disabled'}">
                <input type="checkbox" class="agent-toggle-input" data-agent="${escapeHtml(a.name)}" ${enabled ? 'checked' : ''}>
                <span class="agent-toggle-slider"></span>
            </label>
        </div>`;
    }).join('');

    // Attach ThinkingRotator to each busy agent
    container.querySelectorAll<HTMLElement>('.agent-thinking-text').forEach((el) => {
        const rotator = new ThinkingRotator(el);
        rotator.start();
    });

    // Wire click → agent detail panel (exclude toggle clicks)
    container.querySelectorAll<HTMLElement>('.agent-row--clickable').forEach((row) => {
        row.addEventListener('click', (e) => {
            if ((e.target as Element).closest('.agent-toggle') !== null) return;
            const name = row.dataset['agent'] ?? '';
            if (name !== '') openAgentDetailPanel(name);
        });
    });

    // Wire enable/disable toggles
    container.querySelectorAll<HTMLInputElement>('.agent-toggle-input').forEach((input) => {
        input.addEventListener('change', () => {
            const agentName = input.dataset['agent'] ?? '';
            if (agentName === '') return;
            const row = input.closest('.agent-row');
            void kageOps.setAgentEnabled(agentName, input.checked).then((result) => {
                if (!result.success) {
                    input.checked = !input.checked; // revert on failure
                } else if (row !== null) {
                    row.classList.toggle('agent-row--disabled', !input.checked);
                }
            });
        });
    });
}

// ── Approval Queue ───────────────────────────────────

function initApprovalQueue(): void {
    // Click handlers are in renderApprovals
}

function renderApprovals(approvals: ApprovalInfo[]): void {
    const container = $('#approval-queue');
    const countBadge = $('#approval-count');
    if (container === null) return;

    if (countBadge !== null) {
        countBadge.textContent = String(approvals.length);
    }

    if (approvals.length === 0) {
        // No pending — show empty state + history
        container.innerHTML = '<div class="empty-state">No pending approvals</div>';
        void renderApprovalHistory(container);
        return;
    }

    container.innerHTML = approvals.map((a) => {
        const tc = a.taskCounts;
        const progressBar = tc !== undefined && tc.total > 0
            ? `<div class="approval-progress-bar"><div class="approval-progress-fill" style="width:${Math.round((tc.completed / tc.total) * 100)}%"></div></div>`
            : '';
        const taskSummary = tc !== undefined
            ? `<span class="approval-task-summary">${tc.completed}/${tc.total} tasks done${tc.failed > 0 ? `, ${tc.failed} failed` : ''}</span>`
            : '';

        return `
        <div class="approval-item" data-id="${a.id}">
            <div class="approval-header">
                <div class="approval-info">
                    <div class="approval-project">${escapeHtml(a.name)}</div>
                    <div class="approval-detail">
                        Phase: <strong>${escapeHtml(formatPhaseName(a.phase))}</strong> — awaiting approval
                        ${taskSummary}
                    </div>
                    ${progressBar}
                </div>
                <div class="approval-actions">
                    <button class="btn-approval-details" data-id="${a.id}" title="View details">▶ Details</button>
                    <button class="btn-approve" data-action="approve" data-id="${a.id}">Approve</button>
                    <button class="btn-deny" data-action="deny" data-id="${a.id}">Deny</button>
                </div>
            </div>
            <div class="approval-details-panel" id="approval-details-${a.id}" style="display:none">
                <div class="approval-details-loading">Loading details...</div>
            </div>
        </div>`;
    }).join('');

    // Wire detail toggle buttons
    container.querySelectorAll<HTMLButtonElement>('.btn-approval-details').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            if (id === undefined) return;
            const panel = document.getElementById(`approval-details-${id}`);
            if (panel === null) return;

            const isOpen = panel.style.display !== 'none';
            if (isOpen) {
                panel.style.display = 'none';
                btn.textContent = '▶ Details';
            } else {
                panel.style.display = 'block';
                btn.textContent = '▼ Details';
                void loadApprovalDetails(id, panel);
            }
        });
    });

    // Wire approval buttons.
    // Bugs we fix here:
    //  1. Sidebar bell-badge ("1" next to Mission Control) stayed stale
    //     after approve because #approval-count was never decremented and
    //     refreshAll() was never re-triggered. Both happen now.
    //  2. The approved row never appeared in Approval History because
    //     the history table is only re-rendered on the next renderApprovals
    //     pass. We force a refreshAll() so the granted event shows up.
    container.querySelectorAll('.btn-approve').forEach((btn) => {
        btn.addEventListener('click', () => {
            const el = btn as HTMLButtonElement;
            const id = el.dataset.id;
            if (id === undefined) return;
            void runApprovalAction({
                button: el,
                projectId: id,
                pendingLabel: 'Approving\u2026',
                resultLabel: 'Approved',
                resultBadgeClass: 'badge--approved',
                resultIcon: 'check-circle',
                toastTitle: 'Approval granted',
                run: () => kageOps.approveGate(id),
            });
        });
    });

    container.querySelectorAll('.btn-deny').forEach((btn) => {
        btn.addEventListener('click', () => {
            const el = btn as HTMLButtonElement;
            const id = el.dataset.id;
            if (id === undefined) return;
            void runApprovalAction({
                button: el,
                projectId: id,
                pendingLabel: 'Denying\u2026',
                resultLabel: 'Denied',
                resultBadgeClass: 'badge--denied',
                resultIcon: 'x-circle',
                toastTitle: 'Approval denied',
                run: () => kageOps.denyGate(id),
            });
        });
    });

    // Append history below active approvals
    void renderApprovalHistory(container);
}

/**
 * Run an approve/deny action with immediate UX feedback. The IPC call
 * can take seconds (Sensei dispatches downstream work, writes events,
 * advances phase gates) — without this the user sees a frozen button.
 *
 * Lifecycle:
 *   1. Mark the approval row as in-progress (pending dot + label).
 *   2. Disable both Approve / Deny buttons so duplicate clicks bounce.
 *   3. Run the IPC. On success, swap to the result badge and toast.
 *      On failure, restore the row and toast the error.
 *   4. Trigger refreshAll so the history table + queue stay in sync.
 */
interface ApprovalActionArgs {
    readonly button: HTMLButtonElement;
    readonly projectId: string;
    readonly pendingLabel: string;
    readonly resultLabel: string;
    readonly resultBadgeClass: string;
    readonly resultIcon: IconName;
    readonly toastTitle: string;
    readonly run: () => Promise<void>;
}

async function runApprovalAction(args: ApprovalActionArgs): Promise<void> {
    const item = args.button.closest('.approval-item') as HTMLElement | null;
    const actions = item?.querySelector('.approval-actions') ?? null;

    // Snapshot original markup so we can roll back on error.
    const originalActions = actions?.innerHTML ?? null;
    if (actions !== null) {
        actions.innerHTML =
            `<span class="badge badge--pending">` +
            `<span class="approval-pending-spinner" aria-hidden="true"></span>` +
            `${args.pendingLabel}` +
            `</span>`;
    }
    if (item !== null) {
        item.classList.add('approval-item--working');
        item.style.pointerEvents = 'none';
    }

    let succeeded = false;
    let errMsg = '';
    try {
        await args.run();
        succeeded = true;
    } catch (err: unknown) {
        errMsg = err instanceof Error ? err.message : String(err);
    }

    if (!succeeded) {
        // Restore so the user can try again.
        if (actions !== null && originalActions !== null) {
            actions.innerHTML = originalActions;
        }
        if (item !== null) {
            item.classList.remove('approval-item--working');
            item.style.pointerEvents = '';
        }
        showProjectRunToast(`${args.toastTitle} failed`, errMsg !== '' ? errMsg : 'Unknown error');
        return;
    }

    // Final state — green/red badge with icon.
    if (actions !== null) {
        actions.innerHTML =
            `<span class="badge ${args.resultBadgeClass}">` +
            `${icon(args.resultIcon, { size: 12 })} ${args.resultLabel}` +
            `</span>`;
    }
    if (item !== null) {
        item.classList.remove('approval-item--working');
        item.classList.add('approval-item--resolved');
        item.style.opacity = '0.55';
    }

    // Toast so the user sees confirmation regardless of which panel they're on.
    showProjectRunToast(args.toastTitle, 'Sensei is dispatching the next phase\u2026');

    // Sidebar count + bell badge sync immediately, then re-fetch.
    decrementApprovalCount();
    syncApprovalBadge();
    await refreshAll();
}

/**
 * Show a top-right pop-up alerting the user that an approval is
 * waiting. Pulls the latest approval queue and displays the most
 * recent pending project. Auto-dismisses after 30s if untouched;
 * clicking "Review" jumps to Mission Control.
 */
async function showApprovalPopup(): Promise<void> {
    let pending: readonly ApprovalInfo[] = [];
    try { pending = await kageOps.getApprovalQueue(); } catch { return; }
    if (pending.length === 0) return;
    const top = pending[0];

    // Remove any existing popup so we don't stack them on rapid events.
    document.querySelectorAll('.approval-popup').forEach((n) => n.remove());

    const root = document.createElement('div');
    root.className = 'approval-popup';
    root.setAttribute('role', 'alert');
    root.innerHTML = `
        <div class="approval-popup__head">
            <span class="approval-popup__title">Approval Needed</span>
            <button class="approval-popup__close" aria-label="Dismiss">&times;</button>
        </div>
        <div class="approval-popup__project">${escapeHtml(top.name)}</div>
        <div class="approval-popup__phase">Phase: ${escapeHtml(formatPhaseName(top.phase))} \u2014 awaiting your review</div>
        <div class="approval-popup__body">
            ${pending.length > 1
                ? `${pending.length} approvals pending. Click Review to open the queue.`
                : 'Sensei has paused at a phase gate. Review the work and approve to continue.'}
        </div>
        <div class="approval-popup__actions">
            <button class="approval-popup__btn approval-popup__btn--ghost" data-action="dismiss">Dismiss</button>
            <button class="approval-popup__btn" data-action="review">Review</button>
        </div>`;
    document.body.appendChild(root);

    const dismiss = (): void => { root.remove(); };
    root.querySelector<HTMLButtonElement>('.approval-popup__close')?.addEventListener('click', dismiss);
    root.querySelector<HTMLButtonElement>('[data-action="dismiss"]')?.addEventListener('click', dismiss);
    root.querySelector<HTMLButtonElement>('[data-action="review"]')?.addEventListener('click', () => {
        switchToView('mc');
        // Scroll the approval queue into view.
        document.getElementById('approval-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        dismiss();
    });

    // Auto-dismiss after 30s so it doesn't pile up across phase gates.
    setTimeout(dismiss, 30_000);
}

/** Optimistically subtract 1 from the #approval-count badge text. */
function decrementApprovalCount(): void {
    const countBadge = document.getElementById('approval-count');
    if (countBadge === null) return;
    const cur = Number.parseInt(countBadge.textContent?.trim() ?? '0', 10);
    const next = Number.isFinite(cur) ? Math.max(0, cur - 1) : 0;
    countBadge.textContent = String(next);
}

interface ApprovalHistoryEntry {
    readonly id: string;
    readonly event_type: string;
    readonly agent: string;
    readonly project_id: string;
    readonly project_name: string;
    readonly phase: string;
    readonly created_at: string;
    readonly metadata?: Record<string, unknown> | null;
}

/**
 * Render a Preview / Code toggle block for arbitrary text. Preview tab
 * runs the text through marked() (markdown → HTML); Code tab shows the
 * raw text in a monospace <pre>. Wire with `wireToggleBlocks(root)`.
 */
function renderToggleBlock(
    id: string,
    text: string,
    options: { readonly inlineLabel?: string } = {},
): string {
    const safeId = escapeHtml(id);
    const labelHtml = options.inlineLabel !== undefined
        ? `<strong class="toggle-block__label">${escapeHtml(options.inlineLabel)}:</strong>`
        : '';
    let preview = '';
    try {
        preview = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
    } catch {
        preview = `<p>${escapeHtml(text)}</p>`;
    }
    return `
        <div class="toggle-block" data-toggle-block="${safeId}">
            <div class="toggle-block__head">
                ${labelHtml}
                <div class="toggle-block__tabs" role="tablist">
                    <button class="toggle-block__tab is-active" data-tab="preview" role="tab" aria-selected="true">Preview</button>
                    <button class="toggle-block__tab" data-tab="code" role="tab" aria-selected="false">Code</button>
                </div>
            </div>
            <div class="toggle-block__body toggle-block__body--preview" data-pane="preview">${preview}</div>
            <pre class="toggle-block__body toggle-block__body--code" data-pane="code" style="display:none">${escapeHtml(text)}</pre>
        </div>`;
}

/** Wire click handlers for every Preview/Code toggle block under `root`. */
function wireToggleBlocks(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('.toggle-block').forEach((block) => {
        const tabs = block.querySelectorAll<HTMLButtonElement>('.toggle-block__tab');
        const panes = block.querySelectorAll<HTMLElement>('.toggle-block__body');
        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const target = tab.dataset['tab'] ?? 'preview';
                tabs.forEach((t) => {
                    const isActive = t.dataset['tab'] === target;
                    t.classList.toggle('is-active', isActive);
                    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
                });
                panes.forEach((p) => {
                    const isMatch = p.dataset['pane'] === target;
                    p.style.display = isMatch ? '' : 'none';
                });
            });
        });
    });
}

async function renderApprovalHistory(container: HTMLElement): Promise<void> {
    try {
        const history: readonly ApprovalHistoryEntry[] = await kageOps.getApprovalHistory();
        if (history.length === 0) return;

        // Group into pairs: required → granted/denied. Each row is now
        // expandable — click to reveal the original violations / reason
        // / required-id list from the metadata payload.
        const rows = history.map((entry, idx) => {
            const time = new Date(entry.created_at);
            const timeStr = time.toLocaleString(undefined, {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
            const iconMarkup = entry.event_type === 'approval.granted' ? icon('check-circle', { size: 14 })
                : entry.event_type === 'approval.denied' ? icon('x-circle', { size: 14 })
                : icon('hourglass', { size: 14 });
            const label = entry.event_type === 'approval.granted' ? 'Approved'
                : entry.event_type === 'approval.denied' ? 'Denied'
                : 'Requested';
            const phase = entry.phase.length > 0 ? formatPhaseName(entry.phase) : '';
            const meta = (entry.metadata ?? {}) as Record<string, unknown>;
            const hasDetails = Object.keys(meta).length > 0;

            const detailLines: string[] = [];
            if (typeof meta['reason'] === 'string') detailLines.push(`<div><strong>Reason:</strong> ${escapeHtml(meta['reason'])}</div>`);
            if (typeof meta['currentPhase'] === 'string') detailLines.push(`<div><strong>Current phase:</strong> ${escapeHtml(meta['currentPhase'])}</div>`);
            if (typeof meta['nextPhase'] === 'string') detailLines.push(`<div><strong>Next phase:</strong> ${escapeHtml(meta['nextPhase'])}</div>`);
            if (typeof meta['message'] === 'string') detailLines.push(`<div><strong>Message:</strong> ${escapeHtml(meta['message'])}</div>`);
            if (Array.isArray(meta['requiredIds']) && meta['requiredIds'].length > 0) {
                detailLines.push(`<div><strong>Required IDs:</strong> ${(meta['requiredIds'] as unknown[]).map((id) => `<code>${escapeHtml(String(id))}</code>`).join(', ')}</div>`);
            }
            if (Array.isArray(meta['violations']) && meta['violations'].length > 0) {
                const vlist = (meta['violations'] as Array<Record<string, unknown>>)
                    .map((v) => `<li><code>${escapeHtml(String(v['check'] ?? '?'))}</code>: ${escapeHtml(String(v['message'] ?? ''))}</li>`)
                    .join('');
                detailLines.push(`<div><strong>Violations:</strong><ul style="margin:4px 0 0 18px">${vlist}</ul></div>`);
            }
            const detailJson = `<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--text-muted);font-size:11px">raw payload</summary><pre style="font-size:11px;background:var(--surface-sunken);padding:8px;margin-top:4px;overflow:auto">${escapeHtml(JSON.stringify(meta, null, 2))}</pre></details>`;
            const detailRow = hasDetails
                ? `<tr class="approval-history-detail-row" data-idx="${idx}" style="display:none">
                       <td></td>
                       <td colspan="5" class="approval-history-detail">
                           ${detailLines.join('')}
                           ${detailJson}
                       </td>
                   </tr>`
                : '';
            const expandable = hasDetails ? 'approval-history-row--expandable' : '';

            return `<tr class="${expandable}" data-idx="${idx}" ${hasDetails ? 'style="cursor:pointer"' : ''}>
                <td>${iconMarkup}</td>
                <td>${escapeHtml(entry.project_name)}</td>
                <td>${escapeHtml(phase)}</td>
                <td>${label}</td>
                <td class="approval-history-agent">${escapeHtml(entry.agent)}</td>
                <td class="approval-history-time">${timeStr}${hasDetails ? ' <span style="opacity:0.5">›</span>' : ''}</td>
            </tr>${detailRow}`;
        }).join('');

        const historyHtml = `
            <div class="approval-history-section">
                <div class="approval-history-header">Approval History</div>
                <table class="approval-history-table">
                    <thead><tr>
                        <th></th><th>Project</th><th>Phase</th><th>Action</th><th>By</th><th>Time</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;

        container.insertAdjacentHTML('beforeend', historyHtml);

        // Wire click → toggle the corresponding detail row
        const tbody = container.querySelector('.approval-history-table tbody');
        tbody?.querySelectorAll<HTMLElement>('tr.approval-history-row--expandable').forEach((row) => {
            row.addEventListener('click', () => {
                const idx = row.dataset['idx'];
                if (idx === undefined) return;
                const detail = tbody.querySelector<HTMLElement>(`tr.approval-history-detail-row[data-idx="${idx}"]`);
                if (detail === null) return;
                detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
            });
        });
    } catch {
        // History is optional — fail silently
    }
}

function formatPhaseName(phase: string): string {
    const names: Record<string, string> = {
        'discovery': 'Discovery',
        'poc': 'Proof of Concept',
        'business-viability': 'Business Viability',
        'design-planning': 'Design & Planning',
        'development': 'Development',
        'launch-growth': 'Launch & Growth',
    };
    return names[phase] ?? phase;
}

async function loadApprovalDetails(projectId: string, panel: HTMLElement): Promise<void> {
    try {
        const details: ApprovalDetails | null = await kageOps.getApprovalDetails(projectId);
        if (details === null) {
            panel.innerHTML = '<div class="approval-details-error">Could not load details</div>';
            return;
        }

        const taskRows = details.completedTasks.length > 0
            ? details.completedTasks.map((t) => {
                const agent = t.assignedAgent !== null ? escapeHtml(t.assignedAgent) : '—';
                const score = t.qualityScore !== null ? `${t.qualityScore}/10` : '—';
                const statusIcon = t.status === 'completed' ? icon('check-circle', { size: 14 })
                    : t.status === 'failed' ? icon('x-circle', { size: 14 })
                    : icon('hourglass', { size: 14 });
                return `<tr>
                    <td>${statusIcon}</td>
                    <td>${escapeHtml(t.title)}</td>
                    <td class="approval-detail-agent">${agent}</td>
                    <td class="approval-detail-score">${score}</td>
                </tr>`;
            }).join('')
            : '<tr><td colspan="4" class="approval-details-empty">No tasks in this phase</td></tr>';

        const nextPhaseHtml = details.nextPhase !== null
            ? `<div class="approval-next-phase">
                <strong>Next Phase:</strong> ${escapeHtml(formatPhaseName(details.nextPhase))}
                <div class="approval-next-desc">${escapeHtml(details.nextPhaseDescription)}</div>
               </div>`
            : '<div class="approval-next-phase"><strong>This is the final phase.</strong> Approving will mark the project complete.</div>';

        // Approval description: render with a Preview / Code toggle so the
        // user can scan the formatted version OR drop into the raw text
        // (markdown, prompts with embedded JSON, etc.) before approving.
        const descriptionBlock = details.description !== null
            ? renderToggleBlock('approval-desc', details.description)
            : '';
        const phaseBlock = renderToggleBlock(
            'approval-phase',
            details.phaseDescription,
            { inlineLabel: 'Phase Summary' },
        );

        panel.innerHTML = `
            <div class="approval-details-content">
                ${phaseBlock}
                ${descriptionBlock}
                <div class="approval-tasks-label">Completed Work:</div>
                <table class="approval-tasks-table">
                    <thead><tr><th></th><th>Task</th><th>Agent</th><th>Quality</th></tr></thead>
                    <tbody>${taskRows}</tbody>
                </table>
                ${nextPhaseHtml}
            </div>`;

        // Wire the Preview / Code toggle for every block in the panel.
        wireToggleBlocks(panel);
    } catch {
        panel.innerHTML = '<div class="approval-details-error">Failed to load details</div>';
    }
}

// ── Activity Feed ────────────────────────────────────

function addActivityEvent(event: ActivityEvent): void {
    activityItems = [...activityItems, event].slice(-MAX_ACTIVITY_ITEMS);
    renderActivityFeed();
}

function renderActivityFeed(): void {
    const container = $('#activity-feed');
    if (container === null) return;

    if (activityItems.length === 0) {
        container.innerHTML = `
            <div class="ko-idle-loader">
                <svg class="ko-idle-svg" viewBox="0 0 100 100" fill="none">
                    <path class="ko-stroke-anim" d="M20 30 L48 30" pathLength="100"/>
                    <path class="ko-stroke-anim" d="M20 46 L60 46" pathLength="100"/>
                    <path class="ko-stroke-anim" d="M20 62 L52 62" pathLength="100"/>
                    <path class="ko-stroke-anim" d="M20 78 L72 78" pathLength="100"/>
                    <path class="ko-stroke-anim ko-stroke-anim--accent" d="M76 22 L76 84" pathLength="100"/>
                </svg>
                <div class="ko-idle-phrases">
                    <em class="ko-phrase" style="animation-delay:0s">Waiting for agent activity…</em>
                    <em class="ko-phrase" style="animation-delay:4s">All systems standing by.</em>
                    <em class="ko-phrase" style="animation-delay:8s">The shadows are quiet.</em>
                    <em class="ko-phrase" style="animation-delay:12s">Ready to orchestrate.</em>
                </div>
                <span class="ko-idle-brand">KageOps</span>
            </div>`;
        return;
    }

    container.innerHTML = activityItems.map((e, i) => {
        const severityClass = getActivitySeverityClass(e.message);
        const drillable = hasDrillableData(e);
        const cls = ['activity-item', severityClass, drillable ? 'activity-item--clickable' : '']
            .filter((c) => c !== '').join(' ');
        return `
        <div class="${cls}" data-activity-idx="${i}">
            <span class="activity-time">${formatTime(e.time)}</span>
            <span class="activity-agent">${escapeHtml(e.agent)}</span>
            <span class="activity-message">${escapeHtml(e.message)}</span>
            ${drillable ? `<span class="activity-chevron" aria-hidden="true">\u203a</span>` : ''}
        </div>
    `;
    }).join('');

    // Wire click handlers for drillable rows.
    container.querySelectorAll<HTMLElement>('.activity-item--clickable').forEach((row) => {
        row.addEventListener('click', () => {
            const idxStr = row.dataset['activityIdx'] ?? '';
            const idx = Number.parseInt(idxStr, 10);
            if (!Number.isFinite(idx) || idx < 0 || idx >= activityItems.length) return;
            openActivityDetail(activityItems[idx]);
        });
    });

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
}

/** True if the event carries enough payload that drilling reveals more
 *  than the headline. AI exchanges, task completion data, etc. */
function hasDrillableData(e: ActivityEvent): boolean {
    if (e.data === undefined || e.data === null) return false;
    if (typeof e.data !== 'object') return false;
    return Object.keys(e.data).length > 0;
}

/** Open the float overlay with full event details, including a
 *  Preview/Code toggle for prompt and response when present. */
function openActivityDetail(e: ActivityEvent): void {
    const body = openFloatOverlay(`${e.agent} \u00b7 ${e.channel ?? 'event'}`);
    const data = (e.data ?? {}) as Record<string, unknown>;
    const blocks: string[] = [];

    blocks.push(`
        <div class="activity-detail-header">
            <span class="activity-detail-time">${escapeHtml(formatTime(e.time))}</span>
            <span class="activity-detail-channel">${escapeHtml(e.channel ?? 'event')}</span>
        </div>
        <div class="activity-detail-message">${escapeHtml(e.message)}</div>`);

    // AI-exchange — surface prompt + response with Preview/Code toggle.
    if (e.channel === 'agent.stream' && data['type'] === 'ai-exchange') {
        const meta: string[] = [];
        if (typeof data['model'] === 'string') meta.push(data['model']);
        if (typeof data['tokensIn'] === 'number') {
            const tIn = data['tokensIn'] as number;
            const tOut = typeof data['tokensOut'] === 'number' ? data['tokensOut'] as number : 0;
            meta.push(`${tIn}\u2192${tOut} tok`);
        }
        if (typeof data['costUsd'] === 'number') meta.push(`$${(data['costUsd'] as number).toFixed(4)}`);
        if (meta.length > 0) {
            blocks.push(`<div class="activity-detail-meta">${escapeHtml(meta.join(' \u00b7 '))}</div>`);
        }
        const prompt = (typeof data['prompt'] === 'string' && data['prompt']) ||
                       (typeof data['promptSnippet'] === 'string' && data['promptSnippet']) || '';
        const response = (typeof data['response'] === 'string' && data['response']) ||
                         (typeof data['responseSnippet'] === 'string' && data['responseSnippet']) || '';
        if (prompt !== '') blocks.push(renderToggleBlock('activity-prompt', prompt as string, { inlineLabel: 'Prompt' }));
        if (response !== '') blocks.push(renderToggleBlock('activity-response', response as string, { inlineLabel: 'Response' }));
    } else {
        // Generic events — dump payload as Code only.
        blocks.push(renderToggleBlock(
            'activity-payload',
            JSON.stringify(data, null, 2),
            { inlineLabel: 'Payload' },
        ));
    }

    body.innerHTML = blocks.join('\n');
    wireToggleBlocks(body);
}

// ── Sensei Chat ──────────────────────────────────────

function toggleSenseiFloat(): void {
    const dock = document.getElementById('sensei-chat');
    if (dock === null) return;
    const isHidden = dock.hasAttribute('hidden');
    if (isHidden) {
        dock.removeAttribute('hidden');
        const input = document.getElementById('sensei-input');
        if (input instanceof HTMLInputElement) input.focus();
    } else {
        dock.setAttribute('hidden', '');
    }
    activityBar?.setActive(isHidden ? 'sensei' : 'live');
}

function initSenseiChat(): void {
    const chatEl = $('#sensei-chat');
    const input = $('#sensei-input') as HTMLInputElement | null;
    const sendBtn = $('#btn-sensei-send');
    const statusEl = $('#sensei-status');

    if (input === null || sendBtn === null || chatEl === null) return;

    const expandBtn = $('#sensei-expand-btn');
    if (expandBtn !== null) {
        expandBtn.addEventListener('click', () => toggleSenseiFloat());
    }

    const dock = chatEl;
    const header = dock.querySelector<HTMLElement>('.sensei-header');
    if (header !== null) {
        let dragOffX = 0, dragOffY = 0, dragging = false;
        header.addEventListener('mousedown', (e) => {
            dragging = true;
            dragOffX = e.clientX - dock.getBoundingClientRect().left;
            dragOffY = e.clientY - dock.getBoundingClientRect().top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            dock.style.right = 'auto';
            dock.style.bottom = 'auto';
            // Clamp top so the dock never slides under the title bar (40px on Windows).
            const TOP_BAR_H = 40;
            const newTop = Math.max(TOP_BAR_H, e.clientY - dragOffY);
            const newLeft = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dragOffX));
            dock.style.left = `${newLeft}px`;
            dock.style.top = `${newTop}px`;
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    // ── Resize handles ─────────────────────────────────
    const MIN_W = 260, MAX_W = 800, MIN_H = 200, MAX_H = 900;

    function attachResizeHandle(
        handleId: string,
        onMove: (dx: number, dy: number, startRect: DOMRect) => void,
    ): void {
        const handle = document.getElementById(handleId);
        if (handle === null) return;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startRect = dock.getBoundingClientRect();
            const startX = e.clientX;
            const startY = e.clientY;
            dock.classList.add('is-resizing');
            const onMoveDoc = (ev: MouseEvent): void => {
                onMove(ev.clientX - startX, ev.clientY - startY, startRect);
            };
            const onUp = (): void => {
                dock.classList.remove('is-resizing');
                document.removeEventListener('mousemove', onMoveDoc);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMoveDoc);
            document.addEventListener('mouseup', onUp);
        });
    }

    // Left handle — expand/shrink width from the left edge
    attachResizeHandle('sensei-resize-left', (dx, _dy, startRect) => {
        const newW = Math.min(MAX_W, Math.max(MIN_W, startRect.width - dx));
        dock.style.width = `${newW}px`;
        // If the dock has been dragged (left-anchored), keep right edge fixed
        if (dock.style.left !== '' && dock.style.left !== 'auto') {
            dock.style.left = `${startRect.right - newW}px`;
        }
    });

    // Bottom handle — adjust height (only when dragged off default anchoring)
    attachResizeHandle('sensei-resize-bottom', (_dx, dy, startRect) => {
        const newH = Math.min(MAX_H, Math.max(MIN_H, startRect.height + dy));
        dock.style.height = `${newH}px`;
        // Detach from bottom anchor when user sets explicit height
        if (dock.style.bottom === '' || dock.style.bottom === '0px') {
            dock.style.bottom = 'auto';
        }
    });

    // Corner handle — resize both width and height simultaneously
    attachResizeHandle('sensei-resize-corner', (dx, dy, startRect) => {
        const newW = Math.min(MAX_W, Math.max(MIN_W, startRect.width - dx));
        const newH = Math.min(MAX_H, Math.max(MIN_H, startRect.height + dy));
        dock.style.width = `${newW}px`;
        dock.style.height = `${newH}px`;
        if (dock.style.left !== '' && dock.style.left !== 'auto') {
            dock.style.left = `${startRect.right - newW}px`;
        }
        if (dock.style.bottom === '' || dock.style.bottom === '0px') {
            dock.style.bottom = 'auto';
        }
    });

    const setStatus = (status: string, thinking: boolean): void => {
        if (statusEl === null) return;
        statusEl.textContent = status;
        statusEl.classList.toggle('thinking', thinking);
    };

    // Sensei chat typing indicator — uses the kanji-stroke loader +
    // rotating phrase from ThinkingRotator instead of three bouncing
    // dots. Wraps a kg-thinking host in a sensei-typing row so chat
    // bubble layout stays consistent.
    let senseiTypingRotator: ThinkingRotator | null = null;
    const showTyping = (): HTMLElement | null => {
        const container = $('#sensei-messages');
        if (container === null) return null;
        const row = document.createElement('div');
        row.className = 'sensei-typing';
        row.id = 'sensei-typing-indicator';
        const host = document.createElement('span');
        row.appendChild(host);
        container.appendChild(row);
        container.scrollTop = container.scrollHeight;
        senseiTypingRotator = new ThinkingRotator(host);
        senseiTypingRotator.start();
        return row;
    };

    const hideTyping = (): void => {
        if (senseiTypingRotator !== null) {
            senseiTypingRotator.stop();
            senseiTypingRotator = null;
        }
        const el = document.getElementById('sensei-typing-indicator');
        if (el !== null) el.remove();
    };

    const sendMessage = async (): Promise<void> => {
        const message = input.value.trim();
        if (message === '') return;

        const dockEl = document.getElementById('sensei-chat');
        if (dockEl !== null && dockEl.hasAttribute('hidden')) {
            toggleSenseiFloat();
        }

        appendSenseiMessage(message, 'user');
        input.value = '';

        setStatus('thinking...', true);
        const typingEl = showTyping();

        try {
            const response = await kageOps.sendToSensei(message);
            hideTyping();
            appendSenseiMessage(response, 'sensei');
        } catch {
            hideTyping();
            appendSenseiMessage('The path is unclear. I could not reach my own thoughts.', 'sensei');
        }

        setStatus('ready', false);
    };

    sendBtn.addEventListener('click', () => void sendMessage());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void sendMessage();
    });

}

/**
 * Render Sensei text using full GFM markdown (bold, lists, headings,
 * code fences). User messages stay plain-text + escaped.
 */
function renderSenseiText(text: string): string {
    return marked.parse(text ?? '', { async: false, gfm: true, breaks: true }) as string;
}

function appendSenseiMessage(text: string, from: 'user' | 'sensei'): void {
    const container = $('#sensei-messages');
    if (container === null) return;

    const div = document.createElement('div');
    div.className = `sensei-msg from-${from}`;

    // Meta line — "You · just now" or "Sensei · just now"
    const meta = document.createElement('div');
    meta.className = 'sensei-msg-meta';
    const label = document.createElement('span');
    label.className = 'sensei-msg-label';
    label.textContent = from === 'user' ? 'You' : 'Sensei';
    meta.appendChild(label);
    const time = document.createElement('span');
    time.className = 'sensei-msg-time';
    const nowIso = new Date().toISOString();
    time.textContent = formatRelativeChatTime(nowIso);
    time.setAttribute('title', new Date().toLocaleString());
    meta.appendChild(time);

    const body = document.createElement('div');
    body.className = 'sensei-msg-text';
    if (from === 'sensei') {
        body.innerHTML = renderSenseiText(text);
    } else {
        body.textContent = text;
    }

    div.appendChild(meta);
    div.appendChild(body);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

/**
 * P1-08b: render an inline revision-proposal card in Sensei chat.
 * Triggered by the `revision.proposed` event from Forge's staging
 * path (P1-08a). Fetches the full proposal (with file contents) via
 * `iteration:list-proposed` IPC, hands off to the pure renderer,
 * mounts the result + wires Accept/Reject buttons.
 */
async function renderRevisionProposalInChat(event: ActivityEvent): Promise<void> {
    const container = $('#sensei-messages');
    if (container === null) return;

    const data = (event.data ?? {}) as Record<string, unknown>;
    // Activity events carry projectId/taskId inside `data` (the
    // renderer's ActivityEvent type only models the chat-pulse
    // surface). Read both off `data` directly.
    const projectId = typeof data['projectId'] === 'string' ? data['projectId'] : '';
    const taskId = typeof data['taskId'] === 'string' ? data['taskId'] : '';
    const instruction = typeof data['instruction'] === 'string' ? data['instruction'] as string : null;
    if (projectId === '' || taskId === '') return;

    // Fetch the full proposal payload (file contents + shas).
    const proposalRaw = await kageOps.listRevisionProposal(projectId, taskId);
    if (proposalRaw === null || proposalRaw === undefined) return;

    const { renderRevisionProposal } = await import('./revision-proposal-renderer');
    const div = document.createElement('div');
    div.className = 'sensei-msg from-sensei sensei-msg--revision';
    div.innerHTML = renderRevisionProposal(proposalRaw as never, instruction);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    // Wire Accept/Reject delegate on this card only (so click handlers
    // don't pile up across the chat lifetime).
    div.querySelectorAll<HTMLButtonElement>('.btn-revision').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset['action'];
            const pId = btn.dataset['projectId'] ?? '';
            const tId = btn.dataset['taskId'] ?? '';
            if (pId === '' || tId === '') return;
            // Disable both buttons during the round-trip so a slow
            // accept doesn't get re-clicked into a reject mid-flight.
            div.querySelectorAll<HTMLButtonElement>('.btn-revision').forEach((b) => { b.disabled = true; });
            try {
                if (action === 'accept') {
                    const result = await kageOps.acceptRevisionProposal(pId, tId);
                    if (result.ok) {
                        const n = result.accepted?.length ?? 0;
                        markProposalResolved(div, `Accepted — ${n} file${n === 1 ? '' : 's'} written to workspace.`);
                    } else {
                        markProposalError(div, result.error ?? 'Accept failed');
                    }
                } else if (action === 'reject') {
                    const result = await kageOps.rejectRevisionProposal(pId, tId);
                    if (result.ok) {
                        markProposalResolved(div, 'Rejected — staged proposal discarded.');
                    } else {
                        markProposalError(div, result.error ?? 'Reject failed');
                    }
                }
            } catch (err) {
                markProposalError(div, err instanceof Error ? err.message : String(err));
            }
        });
    });
}

function markProposalResolved(card: HTMLElement, message: string): void {
    const actions = card.querySelector<HTMLElement>('.revision-proposal-actions');
    if (actions !== null) {
        actions.innerHTML = `<div class="revision-proposal-resolved">${message}</div>`;
    }
    card.classList.add('revision-proposal--resolved');
}

function markProposalError(card: HTMLElement, message: string): void {
    const actions = card.querySelector<HTMLElement>('.revision-proposal-actions');
    if (actions !== null) {
        // Re-enable buttons so operator can retry.
        actions.querySelectorAll<HTMLButtonElement>('.btn-revision').forEach((b) => { b.disabled = false; });
        const err = document.createElement('div');
        err.className = 'revision-proposal-error';
        err.textContent = `Error: ${message}`;
        actions.appendChild(err);
    }
}

function formatRelativeChatTime(iso: string): string {
    try {
        const then = new Date(iso).getTime();
        if (!Number.isFinite(then)) return '';
        const diffMs = Date.now() - then;
        if (diffMs < 60_000) return 'just now';
        if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
        if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
        return `${Math.floor(diffMs / 86_400_000)}d ago`;
    } catch { return ''; }
}

// ── New Project Modal ────────────────────────────────

// Pillar 2.2 / PR-B.2 — module-level singletons so the create-handler
// can `collectValues()` from the bundle-picker change-handler's render.
let deploymentConfigSection: DeploymentConfigSection | null = null;
let loadedBundlesCache: readonly BundleSummary[] = [];

async function initDeploymentConfigSection(): Promise<void> {
    const sectionEl = document.getElementById('onboard-deployment-section');
    const bundleSel = document.getElementById('onboard-bundle') as HTMLSelectElement | null;
    if (sectionEl === null || bundleSel === null) return;

    // Bridge is built lazily; bail out if the preload isn't wired (test/build).
    let bridge;
    try {
        bridge = defaultDeploymentConfigBridge();
    } catch (err) {
        console.warn('[deployment-config] preload bridge unavailable:', err);
        // Defensive: render a visible placeholder so the operator can SEE
        // the section exists and report what went wrong, instead of seeing
        // an invisible (`:empty`-hidden) section.
        sectionEl.textContent = 'Deployment configuration unavailable (preload bridge missing). Restart KageOps.';
        return;
    }
    deploymentConfigSection = new DeploymentConfigSection(bridge);

    const remount = async () => {
        const picked = bundleSel.value;
        const bundle = picked === '' ? null : loadedBundlesCache.find((b) => b.name === picked) ?? null;
        await deploymentConfigSection!.mountInto(sectionEl, bundle);
    };
    bundleSel.addEventListener('change', () => {
        void remount();
    });

    // Render the empty-state notice IMMEDIATELY so the section is visible
    // even if listBundles is slow / hangs / throws. The picker fills in
    // behind the scenes.
    await remount();

    // Populate the picker. listBundles failures are non-fatal — picker
    // stays at "(auto)" but the section's empty notice is already up.
    try {
        const res = await kageOps.listBundles();
        loadedBundlesCache = (res.bundles ?? []).map((b) => ({
            name: b.name,
            kind: b.kind,
            description: b.description,
            deployment: (b.deployment as unknown as BundleDeployment | null) ?? null,
        }));
        // Stack bundles only — capability/deployer bundles aren't operator-picked.
        const stacks = loadedBundlesCache.filter((b) => b.kind === 'stack');
        for (const b of stacks) {
            const opt = document.createElement('option');
            opt.value = b.name;
            opt.textContent = `${b.name} — ${shortenDescription(b.description)}`;
            bundleSel.appendChild(opt);
        }
    } catch (err) {
        console.warn('[deployment-config] listBundles failed:', err);
    }
}

function shortenDescription(d: string): string {
    const cleaned = d.replace(/\s+/g, ' ').trim();
    return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
}

function initNewProjectModal(): void {
    const overlay = $('#modal-overlay');
    const btnNew = $('#btn-new-project');
    const btnClose = $('#btn-modal-close');
    const btnCancel = $('#btn-modal-cancel');
    const btnCreate = $('#btn-modal-create');

    if (overlay === null) return;

    // Attach the quickflow drawer + tooltips once on first init.
    attachQuickflow();

    const showModal = (): void => {
        // If the setup wizard just finished, prefill trust + budget from
        // its saved defaults so the user can click Start with sensible values.
        try {
            const raw = sessionStorage.getItem('kageops:wizard-defaults');
            if (raw !== null) {
                const d = JSON.parse(raw) as { trustLevel?: 'low' | 'medium' | 'high'; budgetCapUsd?: number };
                const trustSel = document.getElementById('onboard-trust') as HTMLSelectElement | null;
                const budgetInp = document.getElementById('onboard-budget') as HTMLInputElement | null;
                if (trustSel !== null && d.trustLevel) trustSel.value = d.trustLevel;
                if (budgetInp !== null && typeof d.budgetCapUsd === 'number') budgetInp.value = String(d.budgetCapUsd);
                sessionStorage.removeItem('kageops:wizard-defaults');
            }
        } catch { /* non-fatal */ }
        overlay.classList.remove('hidden');
        // Show the quickflow drawer alongside the modal (idempotent; no-op
        // if user has dismissed it permanently). prefillDefaults runs here
        // and pulls last-project settings via IPC.
        void showQuickflow();
    };
    const hideModal = (): void => {
        overlay.classList.add('hidden');
        hideQuickflow();
    };

    btnNew?.addEventListener('click', showModal);
    btnClose?.addEventListener('click', hideModal);
    btnCancel?.addEventListener('click', hideModal);

    const dryRunPreview = $('#dry-run-preview') as HTMLElement | null;
    const btnDryRun = $('#btn-modal-dry-run') as HTMLButtonElement | null;

    btnDryRun?.addEventListener('click', async () => {
        const nameInput = $('#project-name') as HTMLInputElement | null;
        const descInput = $('#project-desc') as HTMLTextAreaElement | null;
        if (nameInput === null || descInput === null) return;

        const name = nameInput.value.trim();
        const desc = descInput.value.trim();
        if (name === '') {
            showModalError('Please enter a project name before previewing.');
            return;
        }
        if (desc === '') {
            showModalError('Please enter a prompt before previewing.');
            return;
        }

        const originalText = btnDryRun.textContent ?? 'Dry Run';
        btnDryRun.disabled = true;
        btnDryRun.textContent = 'Previewing…';

        try {
            const dryResult = await kageOps.dryRunProject(name, desc);
            if (dryRunPreview !== null) {
                dryRunPreview.style.display = 'block';
                dryRunPreview.textContent = dryResult.success
                    ? (dryResult.preview ?? '(no preview returned)')
                    : (dryResult.error ?? 'Dry run failed');
                dryRunPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showModalError(msg || 'Dry run failed. Check that the orchestrator is running.');
        } finally {
            btnDryRun.disabled = false;
            btnDryRun.textContent = originalText;
        }
    });

    // #165 stage 2 — two-level Phases & Tasks tree + Quick presets.
    renderPhaseTaskTree();
    renderQuickPresets();
    // Default selection on first open: Full product (matches today's behaviour).
    applyQuickPreset('full-product');

    // Pillar 2.2 / PR-B.2 — Deployment Configuration section.
    // Render once on first init; rebound whenever the bundle picker changes.
    void initDeploymentConfigSection();

    btnCreate?.addEventListener('click', async () => {
        const nameInput = $('#project-name') as HTMLInputElement | null;
        const descInput = $('#project-desc') as HTMLTextAreaElement | null;
        const trustSel = $('#onboard-trust') as HTMLSelectElement | null;
        const budgetInp = $('#onboard-budget') as HTMLInputElement | null;
        const typeSel = $('#onboard-type') as HTMLSelectElement | null;
        const stackInp = $('#onboard-stack') as HTMLInputElement | null;
        const goalTa = $('#onboard-goal') as HTMLTextAreaElement | null;
        // Pillar 2.2 PR-E — operator-picked bundle from the dropdown that
        // drives the Deployment Configuration section.
        const bundleSel = $('#onboard-bundle') as HTMLSelectElement | null;

        if (nameInput === null || descInput === null) return;

        const name = nameInput.value.trim();
        const desc = descInput.value.trim();

        if (name === '') {
            showModalError('Please enter a project name.');
            return;
        }
        if (desc === '') {
            showModalError('Please enter a prompt — describe what Sensei should build.');
            return;
        }

        // Phases — at least one must be ticked.
        const enabledPhases: string[] = [];
        document.querySelectorAll<HTMLInputElement>('input[name="phase"]').forEach((cb) => {
            if (cb.checked) enabledPhases.push(cb.value);
        });
        if (enabledPhases.length === 0) {
            showModalError('Pick at least one phase. Sensei needs somewhere to start.');
            return;
        }

        const trustLevel = (trustSel?.value as 'low' | 'medium' | 'high' | undefined) ?? 'low';
        const budgetUsdRaw = Number(budgetInp?.value ?? '');
        const budgetUsd = Number.isFinite(budgetUsdRaw) && budgetUsdRaw > 0 ? budgetUsdRaw : undefined;
        const projectType = typeSel?.value !== '' ? typeSel?.value : undefined;
        const techStack = (stackInp?.value ?? '').trim();
        const goal = (goalTa?.value ?? '').trim();

        const createBtn = btnCreate as HTMLButtonElement;
        const originalText = createBtn.textContent ?? 'Create & Start';
        createBtn.disabled = true;
        createBtn.textContent = 'Creating\u2026';

        try {
            // #165 stage 2 — derive operator-picked task allowlist from the
            // checkbox tree. `null` means "no constraint" (every task type
            // ticked across every enabled phase) and the backend writes
            // NULL into projects.phase_task_selections — legacy behaviour.
            const phaseTaskSelections = derivePhaseTaskSelectionsPayload(
                enabledPhases as readonly Phase[],
                readPhaseTaskSelectionsFromTree(),
            );

            const advArgs: {
                name: string;
                description: string;
                trustLevel?: 'low' | 'medium' | 'high';
                enabledPhases?: readonly string[];
                projectType?: string;
                techStack?: string;
                goal?: string;
                budgetUsd?: number;
                phaseTaskSelections?: PhaseTaskSelections | null;
                selectedBundle?: string;
            } = {
                name,
                description: desc,
                trustLevel,
                enabledPhases,
            };
            if (projectType !== undefined && projectType !== '') advArgs.projectType = projectType;
            if (techStack !== '') advArgs.techStack = techStack;
            if (goal !== '') advArgs.goal = goal;
            if (budgetUsd !== undefined) advArgs.budgetUsd = budgetUsd;
            if (phaseTaskSelections !== null) advArgs.phaseTaskSelections = phaseTaskSelections;
            // Pillar 2.2 PR-E — pass operator's Project Type pick through
            // to Sensei so it skips the keyword matcher. Empty value
            // ("(auto — let Scout pick)") leaves selectedBundle unset
            // and the matcher runs.
            const operatorBundle = (bundleSel?.value ?? '').trim();
            if (operatorBundle !== '') advArgs.selectedBundle = operatorBundle;

            const result = await kageOps.startProjectAdvanced(advArgs);

            if (result.error !== null || result.id === null) {
                showModalError(result.error ?? 'Failed to create project. Is the database running?');
                return;
            }

            const projectId = result.id;

            // Pillar 2.2 / PR-B.2 — Persist deployment config (if collected).
            // Honours D-B: when the operator ticked "Skip for now",
            // collectValues() returns null and we do NOT write a row.
            // The project lands in awaiting-input at the deploy step in
            // that case (lifecycle change comes in PR-D).
            try {
                const collected = deploymentConfigSection?.collectValues() ?? null;
                if (collected !== null && Object.keys(collected.values).length > 0) {
                    const saveRes = await kageOps.deploymentConfig.save(
                        projectId,
                        collected.values
                    );
                    if (!saveRes.success) {
                        console.warn('[deployment-config] save failed:', saveRes.error);
                    }
                    // Phase 2b — also persist to the OS-keychain key register when
                    // the operator opted in, so future runs pick the secrets up.
                    if (collected.saveToKeyRegister) {
                        try {
                            const keyRes = await kageOps.deploymentConfig.saveAppEnv(
                                projectId,
                                collected.values
                            );
                            if (!keyRes.success) {
                                console.warn('[deployment-config] key-register save failed:', keyRes.error);
                            }
                        } catch (err) {
                            console.warn('[deployment-config] key-register save threw:', err);
                        }
                    }
                }
            } catch (err) {
                console.warn('[deployment-config] save threw:', err);
            }

            for (const att of pendingAttachments) {
                await kageOps.uploadDocument(projectId, att.name, att.data, att.mimeType);
            }

            // Reset
            nameInput.value = '';
            descInput.value = '';
            if (goalTa !== null) goalTa.value = '';
            if (stackInp !== null) stackInp.value = '';
            pendingAttachments = [];
            const attachList = document.getElementById('doc-attach-list');
            if (attachList !== null) attachList.innerHTML = '';
            if (dryRunPreview !== null) {
                dryRunPreview.style.display = 'none';
                dryRunPreview.textContent = '';
            }

            hideModal();
            void refreshAll();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showModalError(msg || 'Failed to create project. Check that Docker and the database are running.');
        } finally {
            createBtn.disabled = false;
            createBtn.textContent = originalText;
        }
    });
}

// ── #165 stage 2 — Phases & Tasks two-level checklist ───

/**
 * Build the per-phase tree inside #onboard-phase-task-tree. One <details>
 * block per phase from PHASE_CATALOGUE. Each block has:
 *   - a phase-level checkbox (the existing `name="phase"` input — keeps
 *     all the legacy `input[name="phase"]:checked` selectors working)
 *   - a "select all / select none" mini-link
 *   - one checkbox per task type (`data-phase=X data-task-type=Y`)
 */
function renderPhaseTaskTree(): void {
    const tree = document.getElementById('onboard-phase-task-tree');
    if (tree === null) return;
    if (tree.dataset['rendered'] === '1') return;
    tree.dataset['rendered'] = '1';

    const html = PHASE_CATALOGUE.map((def) => {
        const tasksHtml = def.tasks
            .map((task) => `
                <label class="onboard-task" title="${escapeAttr(task.hint)}">
                    <input type="checkbox"
                           data-phase="${escapeAttr(def.phase)}"
                           data-task-type="${escapeAttr(task.taskType)}"
                           checked>
                    <span class="onboard-task-label">${escapeHtml(task.label)}</span>
                    <span class="onboard-task-agent">${escapeHtml(task.agent)}</span>
                </label>
            `)
            .join('');
        return `
            <details class="onboard-phase-block" data-phase="${escapeAttr(def.phase)}">
                <summary class="onboard-phase-summary">
                    <label class="onboard-phase-toggle">
                        <input type="checkbox" name="phase" value="${escapeAttr(def.phase)}">
                        <span class="onboard-phase-label">${escapeHtml(def.label)}</span>
                    </label>
                    <span class="onboard-phase-hint">${escapeHtml(def.hint)}</span>
                    <span class="onboard-phase-count" data-phase-count="${escapeAttr(def.phase)}"></span>
                </summary>
                <div class="onboard-phase-body">
                    <div class="onboard-task-actions">
                        <button type="button" class="onboard-task-action" data-action="all" data-phase="${escapeAttr(def.phase)}">Select all</button>
                        <button type="button" class="onboard-task-action" data-action="none" data-phase="${escapeAttr(def.phase)}">Clear</button>
                    </div>
                    <div class="onboard-task-grid">${tasksHtml}</div>
                </div>
            </details>
        `;
    }).join('');

    tree.innerHTML = html;

    // CSP forbids inline `onclick=` handlers — stop the phase-toggle label
    // click from bubbling to <summary>, which would otherwise toggle the
    // <details> open/close every time the operator just wants to tick the
    // checkbox.
    tree.querySelectorAll<HTMLLabelElement>('label.onboard-phase-toggle').forEach((lbl) => {
        lbl.addEventListener('click', (e) => e.stopPropagation());
    });

    // Wire phase checkboxes — ticking opens the block + bumps preset to Custom.
    tree.querySelectorAll<HTMLInputElement>('input[name="phase"]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const block = cb.closest('details.onboard-phase-block');
            if (block instanceof HTMLDetailsElement) block.open = cb.checked;
            markCustomPreset();
            updatePhaseCountBadges();
        });
    });

    // Task-type checkboxes — change marks the preset Custom + refresh count.
    tree.querySelectorAll<HTMLInputElement>('input[data-task-type]').forEach((cb) => {
        cb.addEventListener('change', () => {
            markCustomPreset();
            updatePhaseCountBadges();
        });
    });

    // Select-all / Clear actions.
    tree.querySelectorAll<HTMLButtonElement>('.onboard-task-action').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const phase = btn.dataset['phase'];
            const action = btn.dataset['action'];
            if (phase === undefined || action === undefined) return;
            const want = action === 'all';
            tree.querySelectorAll<HTMLInputElement>(`input[data-phase="${cssEscape(phase)}"][data-task-type]`).forEach((cb) => {
                cb.checked = want;
            });
            markCustomPreset();
            updatePhaseCountBadges();
        });
    });

    updatePhaseCountBadges();
}

function renderQuickPresets(): void {
    const host = document.getElementById('onboard-quick-presets');
    if (host === null) return;
    if (host.dataset['rendered'] === '1') return;
    host.dataset['rendered'] = '1';
    const label = host.querySelector('.onboard-quick-presets-label');
    const active = host.querySelector('#onboard-active-preset');
    // Clear existing buttons (if hot-reloaded).
    host.querySelectorAll('button[data-preset-id]').forEach((b) => b.remove());
    const fragment = document.createDocumentFragment();
    for (const preset of QUICK_PRESETS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset['presetId'] = preset.id;
        btn.className = 'onboard-quick-preset-btn';
        btn.textContent = preset.label;
        btn.title = preset.description;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            applyQuickPreset(preset.id);
        });
        fragment.appendChild(btn);
    }
    // Insert buttons between label and active-preset indicator.
    if (active !== null) {
        host.insertBefore(fragment, active);
    } else if (label !== null && label.nextSibling !== null) {
        host.insertBefore(fragment, label.nextSibling);
    } else {
        host.appendChild(fragment);
    }
}

function applyQuickPreset(presetId: string): void {
    const preset = getPreset(presetId);
    if (preset === undefined) return;
    const tree = document.getElementById('onboard-phase-task-tree');
    if (tree === null) return;

    // 1. Phases.
    tree.querySelectorAll<HTMLInputElement>('input[name="phase"]').forEach((cb) => {
        const wantOn = preset.phases.includes(cb.value as Phase);
        cb.checked = wantOn;
        const block = cb.closest('details.onboard-phase-block');
        if (block instanceof HTMLDetailsElement) block.open = wantOn;
    });

    // 2. Task types per phase.
    //    - selections === undefined → tick everything (Full product preset).
    //    - phase listed in selections → tick only those task types.
    //    - phase absent from selections but enabled → tick everything for it
    //      (operator can constrain after the fact).
    //    - phase not enabled → leave checkboxes ticked but block hidden; the
    //      payload derivation strips disabled phases.
    for (const def of PHASE_CATALOGUE) {
        const phaseEnabled = preset.phases.includes(def.phase);
        const wantedForPhase = preset.selections?.[def.phase];
        for (const task of def.tasks) {
            const cb = tree.querySelector<HTMLInputElement>(
                `input[data-phase="${cssEscape(def.phase)}"][data-task-type="${cssEscape(task.taskType)}"]`,
            );
            if (cb === null) continue;
            if (!phaseEnabled) {
                cb.checked = true;
                continue;
            }
            if (preset.selections === undefined || wantedForPhase === undefined) {
                cb.checked = true;
                continue;
            }
            cb.checked = wantedForPhase.includes(task.taskType);
        }
    }

    setActivePresetLabel(preset.label);
    updatePhaseCountBadges();
}

function markCustomPreset(): void {
    setActivePresetLabel('Custom');
}

function setActivePresetLabel(text: string): void {
    const el = document.getElementById('onboard-active-preset');
    if (el !== null) el.textContent = text;
    document.querySelectorAll<HTMLButtonElement>('#onboard-quick-presets button[data-preset-id]').forEach((btn) => {
        const preset = getPreset(btn.dataset['presetId'] ?? '');
        const isActive = preset !== undefined && preset.label === text;
        btn.classList.toggle('is-active', isActive);
    });
}

function updatePhaseCountBadges(): void {
    const tree = document.getElementById('onboard-phase-task-tree');
    if (tree === null) return;
    for (const def of PHASE_CATALOGUE) {
        const total = def.tasks.length;
        const checked = tree.querySelectorAll(
            `input[data-phase="${cssEscape(def.phase)}"][data-task-type]:checked`,
        ).length;
        const badge = tree.querySelector(`[data-phase-count="${cssEscape(def.phase)}"]`);
        if (badge !== null) {
            badge.textContent = `${checked} / ${total}`;
            badge.classList.toggle('is-partial', checked > 0 && checked < total);
            badge.classList.toggle('is-empty', checked === 0);
        }
    }
}

function readPhaseTaskSelectionsFromTree(): Record<string, readonly string[]> {
    const tree = document.getElementById('onboard-phase-task-tree');
    const out: Record<string, string[]> = {};
    if (tree === null) return out;
    tree.querySelectorAll<HTMLInputElement>('input[data-task-type]:checked').forEach((cb) => {
        const phase = cb.dataset['phase'];
        const tt = cb.dataset['taskType'];
        if (phase === undefined || tt === undefined) return;
        if (out[phase] === undefined) out[phase] = [];
        out[phase].push(tt);
    });
    return out;
}

function escapeAttr(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c] ?? c));
}

function cssEscape(s: string): string {
    // CSS attribute selector quoting — simple version: backslash-escape
    // double quotes and backslashes. The phase + task-type values used in
    // this module are safe slugs, but defensive-quote anyway.
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── Project-Run Toast ────────────────────────────────
//
// Kept around for project-run-progress events (errors etc.) even
// though the Start ▾ split-button and standalone Live Run modal are
// gone — both Dry Run and Create & Start now live in the New Project
// modal footer (PR #168). The toast surface is still useful for
// surfacing background event-bus errors during a live run.

function showProjectRunToast(title: string, body: string): void {
    const toast = document.getElementById('project-run-toast');
    const titleEl = toast?.querySelector<HTMLElement>('.project-run-toast__title');
    const bodyEl = document.getElementById('project-run-toast-body');
    const closeBtn = document.getElementById('project-run-toast-close');
    if (toast === null || titleEl === undefined || titleEl === null || bodyEl === null) return;
    titleEl.textContent = title;
    bodyEl.textContent = body;
    toast.classList.remove('hidden');
    closeBtn?.addEventListener('click', () => toast.classList.add('hidden'), { once: true });
}

function initProjectRunProgress(): void {
    kageOps.onProjectRunProgress((payload) => {
        // Dry-run progress stays silent in the toast (we already render the
        // final summary); live-run progress just surfaces meaningful errors.
        if (payload.kind === 'error') {
            showProjectRunToast(
                `${payload.mode === 'dry-run' ? 'Dry Run' : 'Live Run'} — error`,
                payload.error ?? 'Unknown error',
            );
        }
    });
}

// ── Modal Error Banner ──────────────────────────────

function showModalError(message: string): void {
    const existing = document.getElementById('modal-error-banner');
    if (existing !== null) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'modal-error-banner';
    banner.className = 'modal-error-banner';
    banner.textContent = message;

    const modalBody = document.querySelector('.modal-body');
    if (modalBody !== null) {
        modalBody.insertBefore(banner, modalBody.firstChild);
    }

    // Auto-dismiss after 8 seconds
    setTimeout(() => banner.remove(), 8000);
}

// ── Live Updates ─────────────────────────────────────

function initLiveUpdates(): void {
    kageOps.onSenseiMessage((message) => {
        appendSenseiMessage(message, 'sensei');
    });

    // Agent update arrives as { agent, channel, taskId, data } — refresh agent list
    kageOps.onAgentUpdate(() => {
        void kageOps.getAgents().then((agents) => renderAgents(agents)).catch(() => null);
    });

    // Project update arrives as { projectId, channel } — refresh project list
    kageOps.onProjectUpdate(() => {
        void refreshProjectsForTab();
    });

    kageOps.onApprovalNeeded(() => {
        void refreshAll();
        // Show a corner pop-up so the user sees the approval even when
        // viewing a non-Mission-Control panel. Without this the only
        // signal was the activity-bar badge — easy to miss.
        void showApprovalPopup();
        scheduleNotifRefresh();
    });

    kageOps.onActivityEvent((event) => {
        addActivityEvent(event);
        pulseHudFromEvent(event);
        pulseAgentCardFromEvent(event);
        // Also refresh agent/project on task events so progress % stays live
        const ch = (event as ActivityEvent).agent ?? '';
        if (ch) {
            void kageOps.getAgents().then((a) => renderAgents(a)).catch(() => null);
        }
        scheduleNotifRefresh();

        // P1-08b: revision.proposed → render a chat card with diff +
        // Accept/Reject buttons. Only surfaces when
        // KAGEOPS_FEATURE_REVISIONS was on in the main process (the
        // event simply doesn't fire otherwise).
        try {
            const ev = event as ActivityEvent;
            if (ev.channel === 'revision.proposed') {
                void renderRevisionProposalInChat(ev);
            }
        } catch { /* never let renderer crash the listener */ }
    });

    // agent.stream events carry token/cost data and don't always
    // trigger a redraw of project state — pulse the HUD directly so the
    // user sees activity even between task transitions.
    kageOps.onAgentStreamEvent((event) => {
        try {
            const e = event as { agent?: string; data?: Record<string, unknown> };
            const data = e.data ?? {};
            const cost = typeof data['costUsd'] === 'number' ? data['costUsd'] : undefined;
            const tokensIn = typeof data['tokensIn'] === 'number' ? data['tokensIn'] : null;
            const tokensOut = typeof data['tokensOut'] === 'number' ? data['tokensOut'] : null;
            const meta: string[] = [];
            if (tokensIn !== null && tokensOut !== null) meta.push(`${tokensIn}\u2192${tokensOut} tok`);
            if (cost !== undefined) meta.push(`$${cost.toFixed(4)}`);
            const headline = `${e.agent ?? 'agent'} \u00b7 AI exchange${meta.length > 0 ? ' (' + meta.join(' \u00b7 ') + ')' : ''}`;
            pulseLiveHud({ costUsd: cost, headline });
            if (typeof e.agent === 'string') pulseOrchFlowAgent(e.agent);
        } catch {
            // never let HUD wiring crash the listener
        }
    });
}

function pulseHudFromEvent(event: ActivityEvent): void {
    try {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const cost = typeof data['costUsd'] === 'number' ? data['costUsd'] : undefined;
        const headline = `${event.agent ?? 'system'} \u00b7 ${event.message ?? event.channel ?? ''}`;
        pulseLiveHud({ costUsd: cost, headline });
    } catch {
        // never let HUD wiring crash the listener
    }
}

function pulseAgentCardFromEvent(event: ActivityEvent): void {
    const agent = event.agent;
    if (typeof agent !== 'string' || agent.length === 0) return;
    pulseOrchFlowAgent(agent);
}

function pulseOrchFlowAgent(agentName: string): void {
    const lower = agentName.toLowerCase();
    // Orchestration flow uses SVG <g data-agent="id"> nodes for agent
    // cards (see orchestration-flow-panel.ts). Match against that.
    const card = document.querySelector<SVGElement>(`g.orch-agent-node[data-agent="${CSS.escape(lower)}"]`);
    if (card === null) return;
    card.classList.remove('is-pulsing');
    // Force a reflow so re-adding the class restarts the keyframe.
    void (card as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect();
    card.classList.add('is-pulsing');
    setTimeout(() => card.classList.remove('is-pulsing'), 1500);
}

// ── Float Overlay (shared for graph, docs, agent detail, tasks) ─────────────

function openFloatOverlay(title: string): HTMLElement {
    const overlay = document.getElementById('float-overlay');
    const titleEl = document.getElementById('float-overlay-title');
    const body = document.getElementById('float-overlay-body');
    const closeBtn = document.getElementById('float-overlay-close');
    if (overlay === null || titleEl === null || body === null || closeBtn === null) {
        return document.createElement('div');
    }
    titleEl.textContent = title;
    body.innerHTML = '';
    overlay.classList.remove('hidden');
    closeBtn.onclick = closeFloatOverlay;
    overlay.onclick = (e) => { if (e.target === overlay) closeFloatOverlay(); };
    return body;
}

function closeFloatOverlay(): void {
    document.getElementById('float-overlay')?.classList.add('hidden');
}

// ── Agent Detail Panel ───────────────────────────────

function openAgentDetailPanel(agentName: string): void {
    const body = openFloatOverlay(`Agent — ${agentName}`);
    renderAgentDetailPanel(body, agentName, {
        getAgentDetail: (name) => kageOps.getAgentDetail(name) as Promise<any>,
        getTaskOutput: (id) => kageOps.getTaskOutput(id) as Promise<any>,
        getTaskCheckpoints: (id) => kageOps.getTaskCheckpoints(id) as Promise<any>,
        getAgentModelConfig: async (name) => {
            const configs = await kageOps.getAgentModelConfigs();
            return configs.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
        },
        setAgentModel: (name, model, provider) => kageOps.setAgentModel(name, model, provider),
        testAgentModel: (name, model, provider) => kageOps.testAgentModel(name, model, provider),
        setAgentEnabled: (name, enabled) => kageOps.setAgentEnabled(name, enabled),
        isAgentEnabled: async (name) => {
            const configs = await kageOps.getAgentConfigs();
            return configs.find((c) => c.name.toLowerCase() === name.toLowerCase())?.enabled ?? true;
        },
    });
}

// ── Phase Graph Panel ────────────────────────────────

function openPhaseGraphPanel(projectId: string, projectName: string): void {
    const body = openFloatOverlay(`${projectName} — Phase Graph`);
    renderPhaseGraphPanel(body, projectId, projectName, {
        getPhaseGraph: (id) => kageOps.getPhaseGraph(id),
        onAgentClick: (name) => { closeFloatOverlay(); openAgentDetailPanel(name); },
        onTaskClick: (_taskId) => { /* task detail handled inside graph */ },
    });
}

// ── Iteration History Panel (P1-05b) ─────────────────

/**
 * Opens a read-only panel listing every iteration (reopen cycle) for
 * a project. Iteration 0 = original build; 1+ = reopen cycles. The
 * pure renderer lives in iteration-history-renderer.ts so tests can
 * exercise it without pulling in this file's import graph.
 */
async function openIterationHistoryPanel(projectId: string, projectName: string): Promise<void> {
    const body = openFloatOverlay(`${projectName} — Iterations`);
    body.innerHTML = `<div class="empty-state">Loading iterations…</div>`;
    try {
        const { renderIterationHistory } = await import('./iteration-history-renderer');
        const rows = (await kageOps.getIterationHistory(projectId)) as readonly IterationHistoryEntry[];
        body.innerHTML = renderIterationHistory(rows);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        body.innerHTML = `<div class="empty-state">Failed to load iterations: ${escapeHtml(msg)}</div>`;
    }
}

// ── Task Output Panel ────────────────────────────────

function openTaskOutputPanel(projectId: string, projectName: string): void {
    const body = openFloatOverlay(`${projectName} — Tasks`);
    renderTaskOutputPanel(body, projectId, projectName, {
        getProjectTasks: (id) => kageOps.getProjectTasks(id) as Promise<any[]>,
        getTaskOutput: (id) => kageOps.getTaskOutput(id) as Promise<any>,
        getComments: (id) => kageOps.taskGetComments(id) as Promise<any[]>,
        addComment: (id, type, name, body) => kageOps.taskAddComment(id, type, name, body) as Promise<any>,
        getClaim: (id) => kageOps.taskGetClaim(id) as Promise<any>,
        claimTask: (id, uid, uname) => kageOps.taskClaimTask(id, uid, uname) as Promise<any>,
        unclaimTask: (id, uid) => kageOps.taskUnclaimTask(id, uid) as Promise<any>,
    });
}

// ── Document Upload Panel (E1) ───────────────────────

function openDocumentUploadPanel(projectId: string, projectName: string): void {
    const body = openFloatOverlay(`${projectName} — Documents`);
    renderDocumentUploadPanel(body, projectId, projectName, {
        getProjectDocuments: (id) => kageOps.getProjectDocuments(id) as Promise<any[]>,
        uploadDocument: (id, name, data, mime) => kageOps.uploadDocument(id, name, data, mime) as Promise<any>,
        deleteDocument: (docId, projId) => kageOps.deleteDocument(docId, projId) as Promise<any>,
    });
}

// ── Artifact Browser Panel (v2.4) ────────────────────

function openArtifactBrowserPanel(projectId: string, projectName: string, initialFile?: string): void {
    const body = openFloatOverlay(`${projectName} — Artifacts`);
    renderArtifactBrowserPanel(body, projectId, projectName, {
        listArtifactTree: (id, maxDepth) => kageOps.listArtifactTree(id, maxDepth),
        readArtifactFile: (id, relPath) => kageOps.readArtifactFile(id, relPath),
        downloadArtifactZip: (id) => kageOps.downloadArtifactZip(id),
        startLivePreview: (id) => kageOps.startLivePreview(id),
        stopLivePreview: (id) => kageOps.stopLivePreview(id),
        deleteArtifactPath: (id, relPath, recursive) => kageOps.deleteArtifactPath(id, relPath, recursive),
        pushProjectToGitHub: (id) => kageOps.pushProjectToGitHub(id),
        getArtifactTaskDetails: (id, taskId) => kageOps.getArtifactTaskDetails(id, taskId),
        searchArtifacts: (id, query, opts) => kageOps.searchArtifacts(id, query, opts),
    }, initialFile);
}

// ── Configuration Module ─────────────────────────────

// ── Orchestration Flow Graph ─────────────────────────

let orchFlowInstance: { refresh: () => void; setFullscreen: (on: boolean) => void } | null = null;

function initOrchestrationFlow(): void {
    const container = document.getElementById('orch-flow-container');
    if (container === null) return;

    orchFlowInstance = renderOrchestrationFlow(container, {
        getAgentStates: () => cachedAgentStates,
        getCurrentPhase: () => cachedActivePhase,
        onAgentClick: (agentName) => {
            openAgentDetailPanel(agentName);
        },
        onFullscreen: () => {
            const split = document.getElementById('mc-split');
            if (split === null) return;
            const on = split.classList.toggle('mc-flow-fullscreen');
            orchFlowInstance?.setFullscreen(on);
            const headerBtn = document.getElementById('mc-flow-fullscreen');
            if (headerBtn !== null) headerBtn.title = on ? 'Exit fullscreen' : 'Toggle fullscreen';
        },
    });
}

let configRendered = false;

function renderConfigView(): void {
    if (configRendered) return;
    const body = document.getElementById('config-panel-body');
    if (body === null) return;
    renderConfigPanel(body, {
        getConfigSnapshot: () => kageOps.getConfigSnapshot() as Promise<any>,
        configSaveApiKey: (p, k) => kageOps.configSaveApiKey(p, k),
        configPromoteEnvKey: (p) => kageOps.configPromoteEnvKey(p),
        configDeleteApiKey: (p) => kageOps.configDeleteApiKey(p),
        testProvider: (p) => kageOps.testProvider(p),
        saveEnvVar: (k, v) => kageOps.saveEnvVar(k, v),
        getEnvVars: () => kageOps.getEnvVars() as Promise<any>,
        setAgentProvider: (a, p, m) => kageOps.setAgentProvider(a, p, m),
        listProviderKeys: (provider, projectId) => kageOps.listProviderKeys(provider, projectId) as Promise<any>,
        addProviderKey: (provider, label, apiKey, projectId, isDefault) => kageOps.addProviderKey(provider, label, apiKey, projectId, isDefault) as Promise<any>,
        updateProviderKey: (keyId, updates) => kageOps.updateProviderKey(keyId, updates),
        deleteProviderKey: (keyId) => kageOps.deleteProviderKey(keyId),
    });
    // Permissions panel lives in the config view now
    initPermissionsPanel();
    configRendered = true;
}

let connectorsInited = false;

function initConfigModule(): void {
    registerViewInit('config', renderConfigView);

    // OSS gate: Connectors (Slack/Discord/Teams) are a commercial feature —
    // remove the tab + panel entirely in the open build.
    if (!commercialUiAvailable) {
        document.querySelector('[data-config-tab="connectors"]')?.remove();
        document.querySelector('[data-config-panel="connectors"]')?.remove();
    }

    // Tab switching within the config view
    document.querySelectorAll<HTMLButtonElement>('.config-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.dataset['configTab'] ?? '';
            document.querySelectorAll('.config-tab').forEach((t) => {
                t.classList.toggle('config-tab--active', t === tab);
                t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
            });
            document.querySelectorAll<HTMLElement>('.config-tab-panel').forEach((panel) => {
                panel.classList.toggle('hidden', panel.dataset['configPanel'] !== target);
            });

            if (target === 'connectors' && !connectorsInited) {
                connectorsInited = true;
                const host = document.getElementById('connectors-body');
                if (host !== null) {
                    renderConnectorsPanel(host, {
                        getConfig: (name) => kageOps.connectorGetConfig(name),
                        saveConfig: (name, config) => kageOps.connectorSaveConfig(name, config),
                        testConnector: (name, config) => kageOps.connectorTest(name, config),
                        gdriveStatus: () => kageOps.gdriveStatus(),
                        gdriveSignIn: () => kageOps.gdriveSignIn(),
                        gdriveSignOut: () => kageOps.gdriveSignOut(),
                        gdriveListFolders: () => kageOps.gdriveListFolders(),
                    });
                }
            }
        });
    });
}

// ── Agent Terminal panel (B-497) ────────────────────

let agentTerminalHandle: AgentTerminalHandle | null = null;

/**
 * Resolve the project the Terminal panel should tail. The Command Center
 * does not have a single "selected project" cursor today — fall back to
 * the first project in the most-recent fetch. Users will be able to
 * focus a specific project in a later iteration; for v0 this surfaces
 * the most-active project's subprocess output.
 */
function resolveTerminalProjectId(): string | null {
    const first = lastFetchedProjects[0];
    if (first === undefined) return null;
    return first.id ?? null;
}

function initTerminalHubView(): void {
    registerViewInit('terminal-hub', () => {
        const tabs = document.querySelectorAll<HTMLButtonElement>('[data-hub-tab]');
        const panels = document.querySelectorAll<HTMLElement>('[data-hub-panel]');
        let terminalInited = false;
        let logsInited = false;
        let shellInited = false;

        function activateHubTab(target: string): void {
            tabs.forEach((t) => {
                const active = t.dataset['hubTab'] === target;
                t.classList.toggle('is-active', active);
                t.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            panels.forEach((p) => {
                p.classList.toggle('hidden', p.dataset['hubPanel'] !== target);
            });

            if (target === 'agent-terminal' && !terminalInited) {
                terminalInited = true;
                const host = document.getElementById('agent-terminal-body');
                if (host !== null) {
                    agentTerminalHandle = initAgentTerminalPanel(host, {
                        subscribe: (projectId, callback) => kageOps.subscribeAgentTerminal(projectId, callback),
                        getSelectedProjectId: () => resolveTerminalProjectId(),
                    });
                }
            }
            if (target === 'agent-logs' && !logsInited) {
                logsInited = true;
                const host = document.getElementById('agent-logs-body');
                if (host !== null) initAgentLogsPanel(host);
            }
            if (target === 'shell' && !shellInited) {
                shellInited = true;
                const host = document.getElementById('interactive-shell-body');
                if (host !== null) initInteractiveShellPanel(host);
            }
        }

        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const target = tab.dataset['hubTab'];
                if (target !== undefined) activateHubTab(target);
            });
        });

        activateHubTab('shell');
    });
}

function initHelpView(): void {
    registerViewInit('help', () => {
        initHelpPanel();
    });
}

// ── Bootstrap-failure banner ─────────────────────────
// Tooltips were unreliable for surfacing the orchestrator-bootstrap
// failure cause. This banner sits between the top bar and the shell
// and stays visible until the user dismisses it.

let bootErrorBannerWired = false;
let bootErrorBannerDismissed = false;

function updateBootErrorBanner(status: { readonly bootstrapError?: string | null } | null): void {
    const banner = document.getElementById('boot-error-banner') as HTMLElement | null;
    const msgEl = document.getElementById('boot-error-banner-msg');
    if (banner === null || msgEl === null) return;

    const err = status?.bootstrapError ?? null;
    if (err === null || err === '' || bootErrorBannerDismissed) {
        banner.hidden = true;
        return;
    }

    msgEl.textContent = err;
    banner.hidden = false;

    if (bootErrorBannerWired) return;
    bootErrorBannerWired = true;

    const copyBtn = document.getElementById('boot-error-banner-copy');
    if (copyBtn !== null) {
        copyBtn.addEventListener('click', () => {
            const text = msgEl.textContent ?? '';
            const api = (window as unknown as {
                kageOps?: { writeTextToClipboard?: (s: string) => boolean };
            }).kageOps;
            // Prefer the preload-bridged Electron clipboard. The browser
            // navigator.clipboard.writeText is silently rejected here
            // (no clipboard-write permission in the Command Center
            // origin), which is why the Copy button looked dead.
            let ok = false;
            if (api?.writeTextToClipboard !== undefined) {
                ok = api.writeTextToClipboard(text);
            }
            if (!ok) {
                // Last-resort fallback: navigator.clipboard. If both
                // fail at least we tried.
                void navigator.clipboard.writeText(text).then(() => {
                    copyBtn.textContent = 'Copied';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
                }).catch(() => {
                    copyBtn.textContent = 'Copy failed';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
                });
                return;
            }
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
    }
    const dismissBtn = document.getElementById('boot-error-banner-dismiss');
    if (dismissBtn !== null) {
        dismissBtn.addEventListener('click', () => {
            bootErrorBannerDismissed = true;
            banner.hidden = true;
        });
    }
}

// ── Utilities ────────────────────────────────────────

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(isoString: string): string {
    try {
        const d = new Date(isoString);
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '--:--';
    }
}

// ── Shell: Activity Bar + Command Palette (Track C) ───

/**
 * Logical shell view keys. These are the destinations the activity bar
 * and command palette route to. Some map 1:1 to existing view-switcher
 * ViewIds; others focus a panel inside Mission Control (Live).
 */
type ShellViewKey =
    | 'live'
    | 'sensei'
    | 'autonauts'
    | 'knowledge'
    | 'model-routing'
    | 'cost-intel'
    | 'code-graph'
    | 'github'
    | 'deployments'
    | 'cloud-burst'
    | 'apo'
    | 'team'
    | 'terminal-hub'
    | 'help'
    | 'config'
    | 'board';

let activityBar: ActivityBarHandle | null = null;

function initShell(): void {
    const host = document.getElementById('activity-bar-host');
    if (host === null) {
        console.warn('[Shell] activity-bar-host not found, skipping');
        return;
    }

    const views: readonly ActivityBarView[] = [
        { id: 'live', label: 'Mission Control', icon: 'home' },
        { id: 'sensei', label: 'Sensei', icon: 'sensei' },
        { id: 'autonauts', label: 'KageOps Agents', icon: 'bot' },
        { id: 'board', label: 'Project Board', icon: 'kanban' },
        { id: 'knowledge', label: 'Knowledge', icon: 'book-open' },
        { id: 'model-routing', label: 'Model Routing', icon: 'git-branch' },
        { id: 'cost-intel', label: 'Cost Intelligence', icon: 'graph' },
        { id: 'code-graph', label: 'Code Graph', icon: 'spider-web' },
        { id: 'github', label: 'GitHub', icon: 'box' },
        { id: 'deployments', label: 'Deployments', icon: 'cloud-upload' },
        { id: 'cloud-burst', label: 'Cloud Burst', icon: 'zap' },
        { id: 'apo', label: 'APO', icon: 'history' },
        { id: 'team', label: 'Team', icon: 'briefcase' },
        { id: 'terminal-hub', label: 'Terminal', icon: 'terminal' },
        { id: 'help', label: 'Help & Guides', icon: 'help-circle', position: 'bottom' },
        { id: 'config', label: 'Configuration', icon: 'settings', position: 'bottom' },
    ];

    activityBar = initActivityBar(host, {
        // Drop commercial-only rail entries in the open build.
        views: views.filter((v) => commercialUiAvailable || !['deployments', 'cloud-burst', 'team'].includes(v.id)),
        initialActive: 'live',
        onSelect: (id) => routeShellView(id as ShellViewKey),
    });

    // Command palette — mount, bind ⌘K, register commands.
    initCommandPalette();
    registerPaletteCommands();

    // Mission Control VS Code-style bottom panel (replaces legacy initMcTabs).
    initMcTabs();
    initMcBottomPanel();

    // Network resilience toast consumer (Track D).
    mountNetworkToast();

    // Seed approval badge so users can see queued approvals on the rail.
    syncApprovalBadge();
    // MutationObserver is overkill — the approval count element is updated
    // by renderApprovalQueue; poll every 2s which is cheap and reliable.
    setInterval(syncApprovalBadge, 2_000);
}

let networkToast: NetworkToastHandle | null = null;

function mountNetworkToast(): void {
    if (networkToast !== null) return;
    networkToast = initNetworkToast();
    try {
        kageOps.onNetworkEvent((event) => {
            networkToast?.push(event);
        });
    } catch (err) {
        console.warn(
            '[CommandCenter] onNetworkEvent wire failed:',
            err instanceof Error ? err.message : String(err),
        );
    }
}

function routeShellView(key: ShellViewKey): void {
    switch (key) {
        case 'live':
            switchToView('mc');
            break;
        case 'sensei':
            toggleSenseiFloat();
            break;
        case 'autonauts':
            switchToView('au');
            break;
        case 'knowledge':
            switchToView('kb');
            break;
        case 'model-routing':
            switchToView('model-routing');
            break;
        case 'cost-intel':
            switchToView('cost-intel');
            break;
        case 'code-graph':
            switchToView('code-graph');
            break;
        case 'github':
            switchToView('github');
            break;
        case 'deployments':
            switchToView('deployments');
            break;
        case 'cloud-burst':
            switchToView('cloud-burst');
            break;
        case 'apo':
            switchToView('apo');
            break;
        case 'team':
            switchToView('team');
            break;
        case 'terminal-hub':
            switchToView('terminal-hub');
            break;
        case 'board':
            switchToView('board');
            break;
        case 'help':
            switchToView('help');
            break;
        case 'config':
            openConfigOverlay();
            break;
        default: {
            // Exhaustive — never hit; TS narrows to never.
            const exhaustive: never = key;
            void exhaustive;
        }
    }
    activityBar?.setActive(key);
}

function initMcTabs(): void {
    // Legacy tab wiring for [data-mc-tab] / [data-mc-panel] — kept for
    // backward compatibility if any view still uses those attributes.
    const tabs = document.querySelectorAll<HTMLButtonElement>('[data-mc-tab]');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.dataset['mcTab'];
            if (target === undefined) return;
            tabs.forEach((t) => {
                const active = t === tab;
                t.classList.toggle('mc-tab--active', active);
                t.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            document.querySelectorAll<HTMLElement>('[data-mc-panel]').forEach((p) => {
                p.classList.toggle('hidden', p.dataset['mcPanel'] !== target);
            });
        });
    });
}

const EXPAND_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1H1v3M11 4V1H8M8 11h3V8M1 8v3h3"/></svg>`;
const COLLAPSE_ICON = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4h3V1M8 1v3h3M11 8h-3v3M4 11V8H1"/></svg>`;

function initMcBottomPanel(): void {
    const split = document.getElementById('mc-split');
    const bottom = document.getElementById('mc-bottom');
    const dragHandle = document.getElementById('mc-bottom-drag');
    const flowFullscreenBtn = document.getElementById('mc-flow-fullscreen');
    const bottomMaxBtn = document.getElementById('mc-bottom-max');
    const bottomCloseBtn = document.getElementById('mc-bottom-close');
    const bottomReopenBtn = document.getElementById('mc-bottom-reopen');

    if (split === null || bottom === null) return;

    // ── Tab switching ──────────────────────────────────────
    const btabs = document.querySelectorAll<HTMLButtonElement>('[data-btab]');
    btabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const target = tab.dataset['btab'];
            if (target === undefined) return;
            btabs.forEach((t) => {
                t.classList.toggle('mc-btab--active', t === tab);
                t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
            });
            document.querySelectorAll<HTMLElement>('[data-bpanel]').forEach((p) => {
                p.classList.toggle('hidden', p.dataset['bpanel'] !== target);
            });
            // Lazy-init terminal panels on first activation
            lazyInitBPanel(target);
            // Reopen if panel was closed
            split.classList.remove('mc-bottom-closed');
        });
    });

    // ── Approval count auto-switch + badge sync ────────────
    const approvalCount = document.getElementById('approval-count');
    if (approvalCount !== null) {
        new MutationObserver(() => {
            const n = parseInt(approvalCount.textContent ?? '0', 10);
            if (n > 0) {
                document.querySelector<HTMLButtonElement>('[data-btab="approvals"]')?.click();
            }
            syncApprovalBadge();
        }).observe(approvalCount, { childList: true, characterData: true, subtree: true });
    }

    // ── Flow fullscreen ────────────────────────────────────
    flowFullscreenBtn?.addEventListener('click', () => {
        const on = split.classList.toggle('mc-flow-fullscreen');
        if (flowFullscreenBtn !== null) {
            flowFullscreenBtn.title = on ? 'Exit fullscreen' : 'Toggle fullscreen';
        }
        orchFlowInstance?.setFullscreen(on);
    });

    // ── Bottom panel maximize / close ──────────────────────
    bottomMaxBtn?.addEventListener('click', () => {
        const on = split.classList.toggle('mc-bottom-max');
        if (bottomMaxBtn !== null) {
            bottomMaxBtn.title = on ? 'Restore panel' : 'Maximize panel';
            bottomMaxBtn.innerHTML = on ? COLLAPSE_ICON : EXPAND_ICON;
        }
    });

    bottomCloseBtn?.addEventListener('click', () => {
        // Always exit maximize before closing so mc-flow is never hidden
        // at the same time as mc-bottom — that would leave a black screen.
        split.classList.remove('mc-bottom-max');
        if (bottomMaxBtn !== null) {
            bottomMaxBtn.title = 'Maximize panel';
            bottomMaxBtn.innerHTML = EXPAND_ICON;
        }
        split.classList.add('mc-bottom-closed');
    });

    bottomReopenBtn?.addEventListener('click', () => {
        split.classList.remove('mc-bottom-closed');
    });

    // ── Resize drag ────────────────────────────────────────
    if (dragHandle !== null) {
        const STORAGE_KEY = 'kageops-mc-bottom-h';
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved !== null) bottom.style.height = saved;

        let startY = 0;
        let startH = 0;

        dragHandle.addEventListener('mousedown', (e: MouseEvent) => {
            startY = e.clientY;
            startH = bottom.getBoundingClientRect().height;
            dragHandle.classList.add('mc-dragging');

            const onMove = (ev: MouseEvent): void => {
                const delta = startY - ev.clientY;
                const splitH = split.getBoundingClientRect().height;
                const newH = Math.max(80, Math.min(startH + delta, splitH * 0.8));
                const val = `${Math.round(newH)}px`;
                bottom.style.height = val;
                localStorage.setItem(STORAGE_KEY, val);
            };

            const onUp = (): void => {
                dragHandle.classList.remove('mc-dragging');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
    }

}

let mcLogsInited = false;
let mcCliInited = false;

function lazyInitBPanel(target: string): void {
    if (target === 'mc-logs' && !mcLogsInited) {
        mcLogsInited = true;
        const host = document.getElementById('mc-agent-logs-body');
        if (host !== null) initAgentLogsPanel(host);
    }
    if (target === 'mc-cli' && !mcCliInited) {
        mcCliInited = true;
        const host = document.getElementById('mc-shell-body');
        if (host !== null) initInteractiveShellPanel(host);
    }
}


function scrollIntoPanel(panelId: string): void {
    const panel = document.querySelector<HTMLElement>(`.panel[data-panel="${panelId}"]`);
    if (panel === null) return;
    // Expand if collapsed
    panel.classList.remove('collapsed');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Highlight briefly
    panel.classList.add('panel--pulse');
    setTimeout(() => panel.classList.remove('panel--pulse'), 800);
}

function focusSenseiChat(): void {
    const dock = document.getElementById('sensei-chat');
    if (dock !== null && dock.hasAttribute('hidden')) {
        toggleSenseiFloat();
    }
}

function openConfigOverlay(): void {
    renderConfigView();
    switchToView('config');
}

function syncApprovalBadge(): void {
    if (activityBar === null) return;
    const countEl = document.getElementById('approval-count');
    const raw = countEl?.textContent?.trim() ?? '0';
    const n = Number.parseInt(raw, 10);
    activityBar.setBadge('live', Number.isFinite(n) ? n : 0);
}

function registerPaletteCommands(): void {
    // ── Go to ─────────────────────────────────────────
    const goTos: readonly { readonly key: ShellViewKey; readonly title: string; readonly icon: IconName }[] = [
        { key: 'live', title: 'Go to Mission Control', icon: 'home' },
        { key: 'sensei', title: 'Go to Sensei', icon: 'sensei' },
        { key: 'autonauts', title: 'Go to Autonauts', icon: 'bot' },
        { key: 'knowledge', title: 'Go to Knowledge', icon: 'book-open' },
        { key: 'model-routing', title: 'Go to Model Routing', icon: 'git-branch' },
        { key: 'cost-intel', title: 'Go to Cost Intelligence', icon: 'graph' },
        { key: 'code-graph', title: 'Go to Code Graph', icon: 'spider-web' },
        { key: 'github', title: 'Go to GitHub', icon: 'box' },
        { key: 'deployments', title: 'Go to Deployments', icon: 'cloud-upload' },
        { key: 'apo', title: 'Go to APO', icon: 'history' },
        { key: 'team', title: 'Go to Team', icon: 'briefcase' },
        { key: 'config', title: 'Go to Configuration', icon: 'settings' },
    ];
    const visibleGoTos = goTos.filter((g) => commercialUiAvailable || !['deployments', 'cloud-burst', 'team'].includes(g.key));
    for (const g of visibleGoTos) {
        registerCommand({
            id: `goto.${g.key}`,
            title: g.title,
            section: 'go-to',
            icon: g.icon,
            keywords: [g.key],
            run: () => routeShellView(g.key),
        });
    }

    // ── Actions ───────────────────────────────────────
    registerCommand({
        id: 'action.new-project',
        title: 'Create new project',
        section: 'actions',
        icon: 'plus',
        keywords: ['create', 'add', 'new'],
        run: () => {
            const btn = document.getElementById('btn-new-project');
            if (btn instanceof HTMLElement) btn.click();
        },
    });

    registerCommand({
        id: 'action.toggle-theme',
        title: 'Toggle theme (dark / light)',
        section: 'actions',
        icon: 'palette',
        keywords: ['dark', 'light'],
        run: () => {
            const btn = document.getElementById('btn-theme-toggle');
            if (btn instanceof HTMLElement) btn.click();
        },
    });

    registerCommand({
        id: 'action.cancel-current',
        title: 'Cancel current project',
        section: 'actions',
        icon: 'x',
        keywords: ['stop', 'abort', 'kill'],
        run: () => cancelCurrentProject(),
    });

    registerCommand({
        id: 'action.reload',
        title: 'Reload window',
        section: 'actions',
        icon: 'history',
        keywords: ['refresh', 'restart'],
        run: () => window.location.reload(),
    });

    registerCommand({
        id: 'action.open-artifact',
        title: 'Open nearest artifact',
        section: 'actions',
        icon: 'box',
        keywords: ['file', 'document'],
        run: () => {
            // Reveal artifact browser panel; full implementation is Track D.
            scrollIntoPanel('activity');
        },
    });

    registerCommand({
        id: 'action.open-palette',
        title: 'Show command palette',
        section: 'actions',
        icon: 'command',
        keywords: ['help', 'search'],
        shortcut: isMacPlatform() ? '⌘K' : 'Ctrl+K',
        run: () => openCommandPalette(),
    });

    // ── Setup Wizard (Phase 5) ──────────────────────
    registerCommand({
        id: 'action.run-setup-wizard',
        title: 'Run setup wizard',
        section: 'actions',
        icon: 'sparkles',
        keywords: ['wizard', 'setup', 'onboarding', 'first', 'run'],
        run: () => {
            void mountSetupWizard({
                onCreateProject: (defaults) => {
                    try {
                        sessionStorage.setItem('kageops:wizard-defaults', JSON.stringify(defaults));
                    } catch { /* private mode */ }
                    const btn = document.getElementById('btn-new-project');
                    if (btn instanceof HTMLElement) btn.click();
                },
            });
        },
    });

    registerCommand({
        id: 'action.show-quickflow',
        title: 'Show quickflow on next New Project',
        section: 'actions',
        icon: 'help-circle',
        keywords: ['checklist', 'tooltip', 'undismiss', 'quickflow'],
        run: () => {
            try { localStorage.removeItem('kageops:quickflow-dismissed'); } catch { /* private */ }
        },
    });

    // Per-preset quick-switch commands. Mirrors the registry in
    // src/shared/model-registry.ts — keep in sync when adding presets.
    // codex-cli is intentionally omitted while its grandchild-spawn
    // console popup is being worked through; see PresetDef.disabled in
    // model-registry.ts. The adapter wiring stays intact so a power user
    // with KAGEOPS_PRESET=codex-cli in their env can still opt in.
    const KNOWN_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
        { id: 'claude-cli-premium',  label: 'Claude CLI · Premium' },
        { id: 'claude-cli',          label: 'Claude CLI' },
        { id: 'openrouter_standard', label: 'OpenRouter · Standard' },
        { id: 'openrouter_budget',   label: 'OpenRouter · Budget' },
        { id: 'ollama',              label: 'Ollama · Local' },
    ];
    for (const p of KNOWN_PRESETS) {
        registerCommand({
            id: `preset.set-default.${p.id}`,
            title: `Set default preset → ${p.label}`,
            section: 'actions',
            icon: 'git-branch',
            keywords: ['preset', 'switch', 'default', p.id],
            run: () => {
                // Walk the wizard's `select-preset` step against the current
                // state machine. Re-uses the existing onboarding store so it
                // persists into ~/.kageops/onboarding.json. Sensei reads the
                // global default at run time when projects.agent_config_preset
                // is null.
                void (async () => {
                    const w = (window as unknown as {
                        kageOps?: { onboarding: { getState: () => Promise<{ ok: boolean; state?: { step: string } }>; advance: (i: unknown) => Promise<unknown> } };
                    }).kageOps;
                    if (!w?.onboarding) return;
                    const cur = await w.onboarding.getState();
                    if (!cur.ok) return;
                    // If already on `preset` step we just submit; otherwise
                    // we need to walk back, but for simplicity we just no-op
                    // when not on that step (user can use Run setup wizard
                    // instead). Real fix will land with Phase 4 polish.
                    if (cur.state?.step === 'preset') {
                        await w.onboarding.advance({ type: 'select-preset', preset: p.id });
                    } else {
                        // Surface a polite hint via the command palette UI
                        console.info(`[preset] not on preset step — run "Run setup wizard" to change default. Current step: ${cur.state?.step ?? 'unknown'}`);
                    }
                })();
            },
        });
    }

    // ── Recent projects (populated on demand) ─────────
    refreshRecentProjectsCommands();
    // Refresh recent list every 10s so the palette stays current.
    setInterval(refreshRecentProjectsCommands, 10_000);
}

function refreshRecentProjectsCommands(): void {
    kageOps.getProjects().then((projects) => {
        const recent = projects.slice(0, 5);
        recent.forEach((p) => {
            registerCommand({
                id: `recent.${p.id}`,
                title: p.name,
                subtitle: `${p.phase} · ${p.status}`,
                section: 'recent',
                icon: 'layers',
                keywords: [p.phase, p.status],
                run: () => routeShellView('live'),
            });
        });
    }).catch((err: unknown) => {
        console.warn(
            '[Shell] refreshRecentProjectsCommands failed:',
            err instanceof Error ? err.message : String(err),
        );
    });
}

function cancelCurrentProject(): void {
    kageOps.getProjects().then((projects) => {
        const active = projects.find(
            (p) => p.status === 'active' || p.status === 'in_progress',
        );
        if (active === undefined) {
            console.info('[Shell] no active project to cancel');
            return;
        }
        void kageOps.cancelProject(active.id, 'User-initiated via command palette');
    }).catch((err: unknown) => {
        console.error(
            '[Shell] cancelCurrentProject failed:',
            err instanceof Error ? err.message : String(err),
        );
    });
}

function isMacPlatform(): boolean {
    const plat = navigator.platform?.toLowerCase() ?? '';
    return plat.includes('mac');
}

// Suppress "unused import" when ViewId is only used in annotations removed
// during type erasure. Keeping the import ensures future authors can use it.
export type { ViewId };
