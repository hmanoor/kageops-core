/**
 * SMTP Email Adapter
 *
 * Sends email via SMTP using Node's built-in net module.
 * Lightweight implementation — no external dependencies.
 * For production, swap to nodemailer or Azure Communication Services.
 */

import * as net from 'net';
import { ChannelAdapter, CommsMessage } from '../types';
import { getSecret } from '../../main/secret-store';
import { createLogger } from '../../shared/logger';

const log = createLogger('SmtpEmail');

// ── Secret Store Keys ────────────────────────────────

const SERVICE_NAME = 'kageops';
const SMTP_HOST_KEY = 'smtp-host';
const SMTP_PORT_KEY = 'smtp-port';
const SMTP_USER_KEY = 'smtp-user';
const SMTP_PASSWORD_KEY = 'smtp-password';
const SMTP_FROM_KEY = 'smtp-from';

// ── Types ────────────────────────────────────────────

interface SmtpConfig {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly from: string;
}

// ── SMTP Email Adapter ──────────────────────────────

export class SmtpEmailAdapter implements ChannelAdapter {
    readonly channel = 'email' as const;

    async send(message: CommsMessage): Promise<void> {
        const config = await this.loadConfig();

        if (config === null) {
            throw new Error('SMTP not configured. Set smtp-host, smtp-port, smtp-user, smtp-password, smtp-from via secret store.');
        }

        if (message.recipient === null || message.recipient.trim() === '') {
            throw new Error('Email recipient is required.');
        }

        const subject = message.subject ?? 'KageOps Notification';
        const body = message.body;

        await this.sendSmtp(config, message.recipient, subject, body);

        log.info({ recipient: message.recipient, subject }, 'Email sent');
    }

    async isConfigured(): Promise<boolean> {
        const config = await this.loadConfig();
        return config !== null;
    }

    // ── Private Helpers ─────────────────────────────

    private async loadConfig(): Promise<SmtpConfig | null> {
        const [host, portStr, user, password, from] = await Promise.all([
            getSecret(SERVICE_NAME, SMTP_HOST_KEY),
            getSecret(SERVICE_NAME, SMTP_PORT_KEY),
            getSecret(SERVICE_NAME, SMTP_USER_KEY),
            getSecret(SERVICE_NAME, SMTP_PASSWORD_KEY),
            getSecret(SERVICE_NAME, SMTP_FROM_KEY),
        ]);

        if (host === null || user === null || password === null) {
            return null;
        }

        return {
            host,
            port: parseInt(portStr ?? '587', 10),
            user,
            password,
            from: from ?? user,
        };
    }

    private sendSmtp(
        config: SmtpConfig,
        to: string,
        subject: string,
        body: string
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(config.port, config.host);
            let step = 0;

            const commands = [
                `EHLO kageops\r\n`,
                `AUTH LOGIN\r\n`,
                `${Buffer.from(config.user).toString('base64')}\r\n`,
                `${Buffer.from(config.password).toString('base64')}\r\n`,
                `MAIL FROM:<${config.from}>\r\n`,
                `RCPT TO:<${to}>\r\n`,
                `DATA\r\n`,
                `Subject: ${subject}\r\nFrom: ${config.from}\r\nTo: ${to}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.\r\n`,
                `QUIT\r\n`,
            ];

            socket.setTimeout(15_000);

            socket.on('data', (data) => {
                const response = data.toString();
                const code = parseInt(response.substring(0, 3), 10);

                // Accept 2xx and 3xx response codes
                if (code >= 200 && code < 400) {
                    if (step < commands.length) {
                        socket.write(commands[step]);
                        step++;
                    } else {
                        socket.end();
                        resolve();
                    }
                } else {
                    socket.end();
                    reject(new Error(`SMTP error at step ${step}: ${response.trim()}`));
                }
            });

            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error('SMTP connection timed out'));
            });

            socket.on('error', (err) => {
                reject(new Error(`SMTP connection error: ${err.message}`));
            });
        });
    }
}
