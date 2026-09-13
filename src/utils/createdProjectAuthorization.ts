import {
    ApprovedSyncTarget,
    approveSyncTarget,
    createSyncTargetFingerprint,
    isSyncTargetApproved,
    SyncAuthorizationTarget,
} from './syncAuthorization';
import { validateServerUrl } from './serverUrl';
import { validateOverleafId } from './remoteValidation';

export const CREATED_PROJECT_AUTHORIZATION_KEY = 'localleaf.createdProjectSyncTargets.v1';
const MAX_PENDING_TARGETS = 64;

/** Structural subset of VS Code's Memento; no VS Code runtime is needed here. */
export interface SyncAuthorizationStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

const pendingOperations = new WeakMap<SyncAuthorizationStorage, Promise<void>>();

function serially<T>(storage: SyncAuthorizationStorage, operation: () => Promise<T>): Promise<T> {
    const result = (pendingOperations.get(storage) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    pendingOperations.set(storage, settled);
    void settled.then(() => {
        if (pendingOperations.get(storage) === settled) pendingOperations.delete(storage);
    });
    return result;
}

function isLocalWorkspaceUri(value: unknown): value is string {
    if (typeof value !== 'string' || !value || value.length > 32768 || /[\x00-\x1f\x7f]/.test(value)) return false;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'file:' && Boolean(parsed.pathname) && !parsed.search && !parsed.hash;
    } catch {
        return false;
    }
}

function validateTarget(target: SyncAuthorizationTarget): void {
    if (!target || !isLocalWorkspaceUri(target.workspaceUri)) throw new Error('Invalid created-project workspace target.');
    if (typeof target.serverUrl !== 'string') throw new Error('Invalid created-project server target.');
    validateServerUrl(target.serverUrl);
    validateOverleafId(target.projectId, 'project ID');
}

function readPendingTargets(value: unknown): ApprovedSyncTarget[] {
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_PENDING_TARGETS).filter((entry): entry is ApprovedSyncTarget =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        && isLocalWorkspaceUri(entry.workspaceUri)
        && typeof entry.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(entry.fingerprint));
}

/**
 * Call only after explicit Create-and-download consent for the host-selected
 * folder and the ID returned by the successful creation request. The webview
 * must not supply an arbitrary authorization target.
 *
 * Consent has no time limit: opening the created folder later should not ask
 * again. Exact target fingerprints and the 64-record bound limit its scope.
 */
export function approveCreatedProjectSync(
    globalState: SyncAuthorizationStorage,
    target: SyncAuthorizationTarget,
): Promise<void> {
    validateTarget(target);
    // Capture the user's exact target before awaiting another storage operation.
    const captured = { ...target };
    return serially(globalState, async () => {
        const pending = readPendingTargets(globalState.get<unknown>(CREATED_PROJECT_AUTHORIZATION_KEY));
        await globalState.update(CREATED_PROJECT_AUTHORIZATION_KEY, approveSyncTarget(pending, captured));
    });
}

/** Transfer only an exact matching handoff into the current workspace's approval. */
export function consumeCreatedProjectSyncAuthorization(
    globalState: SyncAuthorizationStorage,
    workspaceState: SyncAuthorizationStorage,
    target: SyncAuthorizationTarget,
    workspaceAuthorizationKey: string,
): Promise<boolean> {
    validateTarget(target);
    if (!workspaceAuthorizationKey) throw new Error('A workspace authorization key is required.');
    const captured = { ...target };
    return serially(globalState, async () => {
        const pending = readPendingTargets(globalState.get<unknown>(CREATED_PROJECT_AUTHORIZATION_KEY));
        if (!isSyncTargetApproved(pending, captured)) return false;

        // Never consume the pending consent before the durable workspace grant.
        // If this write fails, reopening the folder can safely try again.
        await workspaceState.update(workspaceAuthorizationKey,
            approveSyncTarget(workspaceState.get<unknown>(workspaceAuthorizationKey), captured));
        const fingerprint = createSyncTargetFingerprint(captured);
        const latest = readPendingTargets(globalState.get<unknown>(CREATED_PROJECT_AUTHORIZATION_KEY));
        await globalState.update(CREATED_PROJECT_AUTHORIZATION_KEY,
            latest.filter(entry => entry.workspaceUri !== captured.workspaceUri || entry.fingerprint !== fingerprint));
        return true;
    });
}
