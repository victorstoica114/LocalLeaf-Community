import { createHash } from 'crypto';

export interface SyncAuthorizationTarget {
    workspaceUri: string;
    serverUrl: string;
    projectId: string;
}

export interface ApprovedSyncTarget {
    workspaceUri: string;
    fingerprint: string;
}

const MAX_APPROVED_TARGETS = 64;

export function createSyncTargetFingerprint(target: SyncAuthorizationTarget): string {
    return createHash('sha256')
        .update(JSON.stringify([
            target.workspaceUri,
            target.serverUrl,
            target.projectId,
        ]))
        .digest('hex');
}

export function isSyncTargetApproved(
    storedValue: unknown,
    target: SyncAuthorizationTarget,
): boolean {
    const fingerprint = createSyncTargetFingerprint(target);
    return readApprovedTargets(storedValue).some(entry =>
        entry.workspaceUri === target.workspaceUri && entry.fingerprint === fingerprint
    );
}

export function approveSyncTarget(
    storedValue: unknown,
    target: SyncAuthorizationTarget,
): ApprovedSyncTarget[] {
    const next = readApprovedTargets(storedValue)
        .filter(entry => entry.workspaceUri !== target.workspaceUri);
    next.push({
        workspaceUri: target.workspaceUri,
        fingerprint: createSyncTargetFingerprint(target),
    });
    return next.slice(-MAX_APPROVED_TARGETS);
}

export function revokeSyncTarget(storedValue: unknown, workspaceUri: string): ApprovedSyncTarget[] {
    return readApprovedTargets(storedValue)
        .filter(entry => entry.workspaceUri !== workspaceUri);
}

function readApprovedTargets(storedValue: unknown): ApprovedSyncTarget[] {
    if (!Array.isArray(storedValue)) return [];
    return storedValue
        .filter((entry): entry is ApprovedSyncTarget => {
            if (!entry || typeof entry !== 'object') return false;
            const candidate = entry as Partial<ApprovedSyncTarget>;
            return typeof candidate.workspaceUri === 'string'
                && candidate.workspaceUri.length > 0
                && candidate.workspaceUri.length <= 32768
                && typeof candidate.fingerprint === 'string'
                && /^[0-9a-f]{64}$/.test(candidate.fingerprint);
        })
        .slice(-MAX_APPROVED_TARGETS);
}
