/** Local metadata excluded from project synchronization. */
const LOCAL_METADATA = new Set(['.localleaf', '.leafignore', '.git', '.vscode']);

/**
 * A small synchronous gate used to prevent overlapping async link operations.
 * JavaScript executes tryEnter atomically before either operation can await.
 */
export class LinkOperationGate {
    private active = false;

    tryEnter(): boolean {
        if (this.active) return false;
        this.active = true;
        return true;
    }

    leave(): void {
        this.active = false;
    }

    get isActive(): boolean {
        return this.active;
    }
}

/** Return true when linking could affect content not created by LocalLeaf. */
export function shouldConfirmProjectLink(entryNames: readonly string[]): boolean {
    return entryNames.some(name => !LOCAL_METADATA.has(name));
}

/**
 * Resolve a project supplied through VS Code's public command boundary against
 * a freshly authenticated server response. Never trust the command argument's
 * name, access level, or other fields: another extension can invoke commands.
 */
export function resolveRequestedProject<T extends { id: string }>(
    availableProjects: readonly T[],
    requested: unknown,
): T | undefined {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
        return undefined;
    }
    const id = (requested as { id?: unknown }).id;
    if (
        typeof id !== 'string'
        || id.length === 0
        || id.length > 1024
        || /[\0\r\n]/.test(id)
    ) {
        return undefined;
    }
    return availableProjects.find(project => project.id === id);
}
