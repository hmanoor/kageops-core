export type ConnectorEventType =
    | 'phase.changed'
    | 'approval.required'
    | 'task.claimed'
    | 'task.commented'      // PR D of F-302 — new comment on a task
    | 'team.member_joined'  // PR D of F-302 — assignment on a project
    | 'agent.error'
    | 'project.launched'
    | 'project.completed';

export interface ConnectorEvent {
    readonly type: ConnectorEventType;
    readonly projectId: string;
    readonly projectName: string;
    readonly actor: string;
    readonly message: string;
    readonly deepLink?: string;
}

export interface ConnectorConfig {
    readonly webhookUrl?: string;
    readonly botToken?: string;
    readonly channelId?: string;
    readonly enabled: boolean;
    // F-373 — WhatsApp via Twilio
    readonly twilioAccountSid?: string;
    readonly twilioAuthToken?: string;
    readonly twilioFromNumber?: string;
    readonly whatsappToNumber?: string;
    // F-374 — Google Drive (outbound artifact mirror)
    readonly googleAccessToken?: string;
    readonly googleFolderId?: string;
}

export interface ConnectorResult {
    readonly ok: boolean;
    readonly error?: string;
}

/**
 * F-373 + F-374: connectors can declare a required subscription tier.
 * Connector-manager filters by the active user's plan before dispatching.
 * Defaults to 'free' (no gating) so existing connectors keep working
 * for everyone.
 */
export type RequiredPlanTier = 'free' | 'team' | 'enterprise';

export interface KageOpsConnector {
    readonly name: string;
    readonly requiredPlan?: RequiredPlanTier;
    test(config: ConnectorConfig): Promise<ConnectorResult>;
    send(event: ConnectorEvent, config: ConnectorConfig): Promise<ConnectorResult>;
}
