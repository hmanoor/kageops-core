/**
 * ActivityBridge unit tests
 *
 * Tests the EventBus → Command Center IPC bridge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockEventBus } from '../helpers/mock-event-bus';
import { ActivityBridge } from '../../src/main/activity-bridge';
import type { EventBus } from '../../src/orchestrator/event-bus';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockWindow(): {
    webContents: { send: ReturnType<typeof vi.fn> };
    isDestroyed: ReturnType<typeof vi.fn>;
} {
    return {
        webContents: { send: vi.fn() },
        isDestroyed: vi.fn(() => false),
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ActivityBridge', () => {
    let eventBus: ReturnType<typeof createMockEventBus>;
    let bridge: ActivityBridge;

    beforeEach(() => {
        eventBus = createMockEventBus();
        bridge = new ActivityBridge();
    });

    describe('start()', () => {
        it('subscribes to all activity channels on the EventBus', () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            // Should subscribe to task, review, approval, build channels
            expect(eventBus.subscribe.mock.calls.length).toBeGreaterThanOrEqual(10);

            const channels = eventBus.subscribe.mock.calls.map(
                (c: unknown[]) => c[0] as string
            );
            expect(channels).toContain('task.completed');
            expect(channels).toContain('task.failed');
            expect(channels).toContain('review.passed');
            expect(channels).toContain('approval.required');
            expect(channels).toContain('build.failed');
        });

        it('is idempotent — second call is a no-op', () => {
            const win = makeMockWindow();
            const config = {
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            };

            bridge.start(config);
            const callCount = eventBus.subscribe.mock.calls.length;

            bridge.start(config);
            expect(eventBus.subscribe.mock.calls.length).toBe(callCount);
        });
    });

    describe('event forwarding', () => {
        it('sends activity event to Command Center window', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('task.completed', {
                projectId: 'proj-1',
                taskId: 'task-1',
                agent: 'forge',
                data: { title: 'User auth', durationMs: 2500 },
            });

            const activityCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:activity-event'
            );
            expect(activityCalls).toHaveLength(1);

            const activityEvent = activityCalls[0][1] as Record<string, unknown>;
            expect(activityEvent.agent).toBe('forge');
            expect(activityEvent.channel).toBe('task.completed');
            expect(activityEvent.severity).toBe('info');
            expect(activityEvent.message).toContain('forge completed');
            expect(activityEvent.message).toContain('User auth');
        });

        it('sends agent-update for task assignment events', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('task.assigned', {
                agent: 'scout',
                taskId: 'task-2',
                data: { title: 'Market research' },
            });

            const agentCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:agent-update'
            );
            expect(agentCalls).toHaveLength(1);
            expect((agentCalls[0][1] as Record<string, unknown>).agent).toBe('scout');
        });

        it('sends project-update for approval events', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('approval.granted', {
                projectId: 'proj-1',
                agent: 'human',
                data: {},
            });

            const projectCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:project-update'
            );
            expect(projectCalls).toHaveLength(1);
            expect((projectCalls[0][1] as Record<string, unknown>).projectId).toBe('proj-1');
        });

        it('sends approval-needed notification for approval.required', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('approval.required', {
                projectId: 'proj-1',
                agent: 'sensei',
                data: { currentPhase: 'development' },
            });

            const approvalCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:approval-needed'
            );
            expect(approvalCalls).toHaveLength(1);
        });

        it('formats failure events with error severity', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('task.failed', {
                agent: 'forge',
                taskId: 'task-3',
                data: { title: 'Auth module', errorMessage: 'Timeout' },
            });

            const activityCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:activity-event'
            );
            const event = activityCalls[0][1] as Record<string, unknown>;
            expect(event.severity).toBe('error');
            expect(event.message).toContain('failed');
            expect(event.message).toContain('Timeout');
        });

        it('formats approval.required with warning severity', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('approval.required', {
                projectId: 'proj-1',
                agent: 'sensei',
                data: { currentPhase: 'poc' },
            });

            const activityCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:activity-event'
            );
            const event = activityCalls[0][1] as Record<string, unknown>;
            expect(event.severity).toBe('warning');
            expect(event.message).toContain('poc');
        });
    });

    describe('intercept and stream forwarding', () => {
        it('subscribes to agent.stream channel on start()', () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            const channels = eventBus.subscribe.mock.calls.map(
                (c: unknown[]) => c[0] as string
            );
            expect(channels).toContain('agent.stream');
        });

        it('subscribes to intercept.acknowledged channel on start()', () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            const channels = eventBus.subscribe.mock.calls.map(
                (c: unknown[]) => c[0] as string
            );
            // intercept.acknowledged is in ACTIVITY_CHANNELS and also subscribed separately
            const count = channels.filter((ch) => ch === 'intercept.acknowledged').length;
            expect(count).toBeGreaterThanOrEqual(1);
        });

        it('forwards agent.stream events to command-center:agent-stream-event IPC', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('agent.stream', {
                agent: 'forge',
                taskId: 'task-42',
                projectId: 'proj-7',
                data: { chunk: 'Building auth module...' },
            });

            const streamCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:agent-stream-event'
            );
            expect(streamCalls).toHaveLength(1);

            const payload = streamCalls[0][1] as Record<string, unknown>;
            expect(payload.agent).toBe('forge');
            expect(payload.taskId).toBe('task-42');
            expect(payload.projectId).toBe('proj-7');
            expect((payload.data as Record<string, unknown>).chunk).toBe('Building auth module...');
        });

        it('also routes agent.stream events to the general activity feed for click-to-expand', async () => {
            // Mission Control's activity feed shows agent.stream rows so users
            // can click into the prompt/response detail without switching
            // panes. The dedicated agent-stream-event channel still fires
            // (verified by the test above); this verifies the second path.
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('agent.stream', {
                agent: 'forge',
                taskId: 'task-42',
                data: { chunk: 'token' },
            });

            const activityCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:activity-event'
            );
            expect(activityCalls).toHaveLength(1);
            const activityPayload = activityCalls[0][1] as Record<string, unknown>;
            expect(activityPayload.channel).toBe('agent.stream');
            expect(activityPayload.agent).toBe('forge');
            expect(activityPayload.taskId).toBe('task-42');
        });

        it('forwards intercept.acknowledged events to command-center:intercept-ack IPC', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('intercept.acknowledged', {
                agent: 'vigil',
                taskId: 'task-99',
                data: { decision: 'approved', reason: 'Looks fine' },
            });

            const ackCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:intercept-ack'
            );
            expect(ackCalls).toHaveLength(1);

            const payload = ackCalls[0][1] as Record<string, unknown>;
            expect(payload.agent).toBe('vigil');
            expect(payload.taskId).toBe('task-99');
            expect((payload.data as Record<string, unknown>).decision).toBe('approved');
        });

        it('does not forward agent.stream when window is null', async () => {
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => null,
            });

            await expect(
                eventBus.triggerEvent('agent.stream', {
                    agent: 'forge',
                    data: { chunk: 'partial output' },
                })
            ).resolves.not.toThrow();
        });

        it('does not forward agent.stream when window is destroyed', async () => {
            const win = makeMockWindow();
            win.isDestroyed.mockReturnValue(true);

            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('agent.stream', {
                agent: 'forge',
                data: { chunk: 'partial output' },
            });

            const streamCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:agent-stream-event'
            );
            expect(streamCalls).toHaveLength(0);
        });

        it('does not forward intercept.acknowledged when window is null', async () => {
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => null,
            });

            await expect(
                eventBus.triggerEvent('intercept.acknowledged', {
                    agent: 'vigil',
                    taskId: 'task-99',
                    data: { decision: 'approved' },
                })
            ).resolves.not.toThrow();
        });

        it('does not forward intercept.acknowledged when window is destroyed', async () => {
            const win = makeMockWindow();
            win.isDestroyed.mockReturnValue(true);

            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await eventBus.triggerEvent('intercept.acknowledged', {
                agent: 'vigil',
                taskId: 'task-99',
                data: { decision: 'approved' },
            });

            const ackCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:intercept-ack'
            );
            expect(ackCalls).toHaveLength(0);
        });

        it('does not forward stream or ack events after stop()', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            bridge.stop();

            await eventBus.triggerEvent('agent.stream', {
                agent: 'forge',
                data: { chunk: 'post-stop' },
            });

            await eventBus.triggerEvent('intercept.acknowledged', {
                agent: 'vigil',
                taskId: 'task-99',
                data: { decision: 'approved' },
            });

            const streamCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:agent-stream-event'
            );
            const ackCalls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:intercept-ack'
            );
            expect(streamCalls).toHaveLength(0);
            expect(ackCalls).toHaveLength(0);
        });
    });

    describe('pushActivity()', () => {
        it('sends a custom event directly to command-center:activity-event', () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            bridge.pushActivity({
                agent: 'sensei',
                message: 'Project initialised',
                severity: 'info',
            });

            const calls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:activity-event'
            );
            expect(calls).toHaveLength(1);

            const payload = calls[0][1] as Record<string, unknown>;
            expect(payload.agent).toBe('sensei');
            expect(payload.message).toBe('Project initialised');
            expect(payload.severity).toBe('info');
            expect(typeof payload.time).toBe('string');
        });

        it('defaults severity to info and channel to system.info when omitted', () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            bridge.pushActivity({ agent: 'sensei', message: 'Boot complete' });

            const calls = win.webContents.send.mock.calls.filter(
                (c: unknown[]) => c[0] === 'command-center:activity-event'
            );
            const payload = calls[0][1] as Record<string, unknown>;
            expect(payload.severity).toBe('info');
            expect(payload.channel).toBe('system.info');
        });

        it('does not send when bridge is not started', () => {
            const win = makeMockWindow();
            // bridge created in beforeEach but start() never called here
            const freshBridge = new ActivityBridge();

            freshBridge.pushActivity({ agent: 'sensei', message: 'Should not send' });

            expect(win.webContents.send).not.toHaveBeenCalled();
        });

        it('does not send when window is null', () => {
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => null,
            });

            expect(() => {
                bridge.pushActivity({ agent: 'sensei', message: 'No window' });
            }).not.toThrow();
        });

        it('does not send when window is destroyed', () => {
            const win = makeMockWindow();
            win.isDestroyed.mockReturnValue(true);

            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            bridge.pushActivity({ agent: 'sensei', message: 'Destroyed window' });

            expect(win.webContents.send).not.toHaveBeenCalled();
        });

        it('does not send after stop()', () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            bridge.stop();
            bridge.pushActivity({ agent: 'sensei', message: 'Post-stop' });

            expect(win.webContents.send).not.toHaveBeenCalled();
        });

        it('does not throw when webContents.send throws during pushActivity', () => {
            const win = makeMockWindow();
            win.webContents.send.mockImplementation(() => {
                throw new Error('IPC closed');
            });

            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            expect(() => {
                bridge.pushActivity({ agent: 'sensei', message: 'Boom' });
            }).not.toThrow();
        });
    });

    describe('edge cases', () => {
        it('does not throw when window is null', async () => {
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => null,
            });

            await expect(
                eventBus.triggerEvent('task.completed', {
                    agent: 'forge',
                    data: { title: 'Test' },
                })
            ).resolves.not.toThrow();
        });

        it('does not throw when window is destroyed', async () => {
            const win = makeMockWindow();
            win.isDestroyed.mockReturnValue(true);

            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await expect(
                eventBus.triggerEvent('task.completed', {
                    agent: 'forge',
                    data: { title: 'Test' },
                })
            ).resolves.not.toThrow();

            // No IPC should be sent
            expect(win.webContents.send).not.toHaveBeenCalled();
        });

        it('does not forward events after stop()', async () => {
            const win = makeMockWindow();
            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            bridge.stop();

            await eventBus.triggerEvent('task.completed', {
                agent: 'forge',
                data: { title: 'Test' },
            });

            expect(win.webContents.send).not.toHaveBeenCalled();
        });

        it('does not crash when webContents.send throws', async () => {
            const win = makeMockWindow();
            win.webContents.send.mockImplementation(() => {
                throw new Error('IPC channel closed');
            });

            bridge.start({
                eventBus: eventBus as unknown as EventBus,
                getWindow: () => win as never,
            });

            await expect(
                eventBus.triggerEvent('task.completed', {
                    agent: 'forge',
                    data: { title: 'Test' },
                })
            ).resolves.not.toThrow();
        });
    });
});
