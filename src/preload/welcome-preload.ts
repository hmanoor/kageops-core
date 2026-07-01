import { contextBridge, ipcRenderer } from 'electron';

// Inline channel names — sandboxed preloads cannot require relative paths.
const CH = {
    GET_VERSION:  'welcome:get-version',
    DISMISS:      'welcome:dismiss',
    OPEN_DOCS:    'welcome:open-docs',
    QUICK_ACTION: 'welcome:quick-action',
} as const;

contextBridge.exposeInMainWorld('kageOpsWelcome', {
    getVersion: (): Promise<string> =>
        ipcRenderer.invoke(CH.GET_VERSION),

    dismiss: (): Promise<void> =>
        ipcRenderer.invoke(CH.DISMISS),

    openDocs: (): Promise<void> =>
        ipcRenderer.invoke(CH.OPEN_DOCS),

    quickAction: (kind: 'new-project' | 'open-settings'): Promise<void> =>
        ipcRenderer.invoke(CH.QUICK_ACTION, kind),
});
