import { noopCommercialExtensions } from './commercial-extensions';
import type { CommercialExtensions } from './commercial-extensions';

// OPEN STUB — the commercial layer is absent in kageops-core.
export function registerCommercialPreReadySchemes(): void {}

export async function loadCommercialExtensions(): Promise<CommercialExtensions> {
    return noopCommercialExtensions;
}
