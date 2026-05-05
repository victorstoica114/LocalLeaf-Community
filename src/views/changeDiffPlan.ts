import { ChangeType } from '../sync/changeTracker';

export type DiffSide = 'base' | 'local' | 'remote' | 'empty';

export interface ChangeDiffPlanInput {
    localChangeType?: ChangeType;
    remoteChangeType?: ChangeType;
    hasRemoteContent: boolean;
}

export interface ChangeDiffPlan {
    left: DiffSide;
    right: DiffSide;
    titleKind: 'Base ↔ Local' | 'Local ↔ Remote';
    requiresRemoteContent: boolean;
}

export function cleanChangePath(path: string): string {
    return path.replace(/^\/+/, '');
}

export function createChangeDiffPlan(input: ChangeDiffPlanInput): ChangeDiffPlan {
    if (input.localChangeType && !input.remoteChangeType) {
        return {
            left: 'base',
            right: input.localChangeType === 'deleted' ? 'empty' : 'local',
            titleKind: 'Base ↔ Local',
            requiresRemoteContent: false,
        };
    }

    if (input.remoteChangeType && !input.localChangeType) {
        return {
            left: input.remoteChangeType === 'created' ? 'empty' : 'local',
            right: input.remoteChangeType === 'deleted' ? 'empty' : 'remote',
            titleKind: 'Local ↔ Remote',
            requiresRemoteContent: input.remoteChangeType !== 'deleted' && !input.hasRemoteContent,
        };
    }

    if (input.localChangeType || input.remoteChangeType) {
        return {
            left: input.localChangeType === 'deleted' ? 'empty' : 'local',
            right: input.remoteChangeType === 'deleted' ? 'empty' : 'remote',
            titleKind: 'Local ↔ Remote',
            requiresRemoteContent: input.remoteChangeType !== 'deleted' && !input.hasRemoteContent,
        };
    }

    return {
        left: 'local',
        right: 'remote',
        titleKind: 'Local ↔ Remote',
        requiresRemoteContent: false,
    };
}
