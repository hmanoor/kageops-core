import { Notification } from 'electron';
import { getCommandCenterWindow } from './command-center-window';
import { IPC } from '../shared/ipc-channels';

export function notifyApprovalRequired(opts: {
    readonly projectName: string;
    readonly taskTitle: string;
    readonly requestedBy: string;
    readonly taskId: string;
}): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({
        title: `Approval needed — ${opts.projectName}`,
        body: `${opts.requestedBy} is waiting: ${opts.taskTitle}`,
        urgency: 'normal',
    });
    n.on('click', () => {
        const win = getCommandCenterWindow();
        if (win !== null) {
            win.focus();
            win.webContents.send(IPC.AGENT_STREAM_EVENT, {
                type: 'focus-task',
                taskId: opts.taskId,
            });
        }
    });
    n.show();
}

export function notifyTaskClaimed(opts: {
    readonly projectName: string;
    readonly taskTitle: string;
    readonly claimedBy: string;
}): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({
        title: `Task claimed — ${opts.projectName}`,
        body: `${opts.claimedBy} claimed: ${opts.taskTitle}`,
        urgency: 'low',
    });
    n.show();
}

export function notifyPhaseChanged(opts: {
    readonly projectName: string;
    readonly phase: string;
}): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({
        title: opts.projectName,
        body: `Entered phase: ${opts.phase}`,
        urgency: 'low',
    });
    n.show();
}

/**
 * PR D of F-302 — surface a teammate's comment on a task.
 * Click focuses the Command Center on the task so the user can read the
 * thread without hunting through the project list.
 */
export function notifyTaskCommented(opts: {
    readonly projectName: string;
    readonly taskTitle: string;
    readonly authorName: string;
    readonly excerpt: string;
    readonly taskId: string;
}): void {
    if (!Notification.isSupported()) return;
    // Trim long bodies so the OS notification stays readable. macOS / Windows
    // both clip ~100 chars; we cap shorter and add an ellipsis so the
    // important "who said what" prefix doesn't get truncated.
    const body = opts.excerpt.length > 80
        ? `${opts.authorName}: ${opts.excerpt.slice(0, 80)}…`
        : `${opts.authorName}: ${opts.excerpt}`;
    const n = new Notification({
        title: `New comment — ${opts.projectName}`,
        body,
        urgency: 'low',
    });
    n.on('click', () => {
        const win = getCommandCenterWindow();
        if (win !== null) {
            win.focus();
            win.webContents.send(IPC.AGENT_STREAM_EVENT, {
                type: 'focus-task',
                taskId: opts.taskId,
            });
        }
    });
    n.show();
}

/**
 * PR D of F-302 — surface a new project assignment to the operator.
 * Used when someone is added to a project they didn't create.
 */
export function notifyMemberJoined(opts: {
    readonly projectName: string;
    readonly memberName: string;
    readonly invitedBy: string;
}): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({
        title: `New teammate on ${opts.projectName}`,
        body: `${opts.invitedBy} added ${opts.memberName} to the project.`,
        urgency: 'low',
    });
    n.show();
}
