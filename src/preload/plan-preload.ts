import { contextBridge, ipcRenderer } from 'electron';

// Inline channel names — sandboxed preloads cannot require relative paths.
const CH = {
    GET_STRIPE_KEY:   'plan:get-stripe-key',
    GET_SESSION:      'plan:get-session',
    CONTINUE_FREE:    'plan:continue-free',
    OPEN_CHECKOUT:    'plan:open-checkout',
    OPEN_PORTAL:      'plan:open-portal',
    STRIPE_CALLBACK:  'plan:stripe-callback',
    CONFIRM_SELECTED: 'plan:confirm-selected',
} as const;

contextBridge.exposeInMainWorld('kageOpsPlans', {
    getStripePublishableKey: (): Promise<string> =>
        ipcRenderer.invoke(CH.GET_STRIPE_KEY),

    getSession: (): Promise<{
        userId: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        plan: string;
    } | null> => ipcRenderer.invoke(CH.GET_SESSION),

    continueFree: (): Promise<void> =>
        ipcRenderer.invoke(CH.CONTINUE_FREE),

    openCheckout: (args: {
        tier: 'team' | 'enterprise';
        annual: boolean;
    }): Promise<{ ok?: boolean; error?: string }> =>
        ipcRenderer.invoke(CH.OPEN_CHECKOUT, args),

    openPortal: (): Promise<void> =>
        ipcRenderer.invoke(CH.OPEN_PORTAL),

    onStripeCallback: (handler: (url: string) => void): void => {
        ipcRenderer.on(CH.STRIPE_CALLBACK, (_event, url: string) => handler(url));
    },

    confirmSelected: (): Promise<void> =>
        ipcRenderer.invoke(CH.CONFIRM_SELECTED),
});
