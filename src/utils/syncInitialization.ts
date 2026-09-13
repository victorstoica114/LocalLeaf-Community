export interface SyncInitializationSnapshot {
    deactivating: boolean;
    currentGeneration: number;
    expectedGeneration: number;
    currentSyncKey: string | undefined;
    activeSyncKey: string | undefined;
    expectedSyncKey: string;
}

/**
 * An asynchronous initialization owns the sync session only while both its
 * generation and exact workspace/server/project key still match.
 */
export function isSyncInitializationSnapshotCurrent(snapshot: SyncInitializationSnapshot): boolean {
    return !snapshot.deactivating
        && snapshot.currentGeneration === snapshot.expectedGeneration
        && snapshot.currentSyncKey === snapshot.expectedSyncKey
        && snapshot.activeSyncKey === snapshot.expectedSyncKey;
}

/** Catch up after a meaningful absence, without polling a healthy connection. */
export function createWindowFocusListener(
    onRefocus: () => void,
    now: () => number = Date.now,
): (state: { focused: boolean }) => void {
    let blurredAt: number | undefined;
    return ({ focused }) => {
        if (!focused) {
            blurredAt ??= now();
            return;
        }
        const absentSince = blurredAt;
        blurredAt = undefined;
        if (absentSince !== undefined && now() - absentSince >= 30_000) onRefocus();
    };
}
