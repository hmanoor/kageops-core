/**
 * Teams Webhook Adapter
 *
 * Sends messages to Microsoft Teams via Incoming Webhook URL.
 * Uses Adaptive Card format for rich message presentation.
 */

import { ChannelAdapter, CommsMessage } from '../types';
import { getSecret } from '../../main/secret-store';
import { createLogger } from '../../shared/logger';

const log = createLogger('TeamsWebhook');

// ── Constants ────────────────────────────────────────

const SERVICE_NAME = 'kageops';
const TEAMS_WEBHOOK_ACCOUNT = 'teams-webhook-url';
const REQUEST_TIMEOUT_MS = 10_000;

// ── Adaptive Card Builder ────────────────────────────

function buildAdaptiveCard(message: CommsMessage): Record<string, unknown> {
    const facts: Array<{ title: string; value: string }> = [];

    if (message.projectId !== null) {
        facts.push({ title: 'Project', value: message.projectId });
    }

    return {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: [
                        ...(message.subject !== null ? [{
                            type: 'TextBlock',
                            text: message.subject,
                            weight: 'Bolder',
                            size: 'Medium',
                        }] : []),
                        {
                            type: 'TextBlock',
                            text: message.body,
                            wrap: true,
                        },
                        ...(facts.length > 0 ? [{
                            type: 'FactSet',
                            facts,
                        }] : []),
                    ],
                },
            },
        ],
    };
}

// ── Teams Webhook Adapter ────────────────────────────

export class TeamsWebhookAdapter implements ChannelAdapter {
    readonly channel = 'teams' as const;

    async send(message: CommsMessage): Promise<void> {
        const webhookUrl = await getSecret(SERVICE_NAME, TEAMS_WEBHOOK_ACCOUNT);

        if (webhookUrl === null) {
            throw new Error('Teams webhook URL not configured. Set via secret store.');
        }

        const card = buildAdaptiveCard(message);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(card),
                signal: controller.signal,
            });

            if (!response.ok) {
                const text = await response.text().catch(() => 'unknown');
                throw new Error(`Teams webhook returned ${response.status}: ${text}`);
            }

            log.info({ subject: message.subject ?? '(no subject)' }, 'Message sent');
        } finally {
            clearTimeout(timeout);
        }
    }

    async isConfigured(): Promise<boolean> {
        const webhookUrl = await getSecret(SERVICE_NAME, TEAMS_WEBHOOK_ACCOUNT);
        return webhookUrl !== null && webhookUrl.startsWith('https://');
    }
}
