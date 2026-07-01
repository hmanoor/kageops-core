import { noopBootstrapExtensions } from './bootstrap-extensions';
import type { BootstrapExtensions } from './bootstrap-extensions';

// OPEN STUB — the commercial layer is absent in kageops-core. The open build
// runs on the no-op defaults (openPlanGate, no-op post-deploy hook, etc.).
export async function loadBootstrapExtensions(): Promise<BootstrapExtensions> {
    return noopBootstrapExtensions;
}
