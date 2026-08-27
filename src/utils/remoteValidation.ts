/**
 * Limits and validators for data received from an Overleaf server.
 *
 * These checks belong at the transport boundary so malformed responses cannot
 * reach the synchronization engine or trigger unbounded processing.
 */

export const MAX_REMOTE_DOCUMENT_CHARACTERS = 10 * 1024 * 1024;
export const MAX_REMOTE_DOCUMENT_LINES = 200_000;
export const MAX_REMOTE_DOCUMENT_OPERATIONS = 10_000;
export const MAX_REMOTE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_OVERLEAF_ID_LENGTH = 1024;

export function validateOverleafId(value: unknown, label: string): string {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_OVERLEAF_ID_LENGTH
        || /[\0\r\n]/.test(value)
    ) {
        throw new Error(`Invalid Overleaf ${label}.`);
    }
    return value;
}

export function validateRemoteDocumentLines(
    value: unknown,
    label: string = 'document content',
): string[] {
    if (!Array.isArray(value) || value.length > MAX_REMOTE_DOCUMENT_LINES) {
        throw new Error(`Overleaf returned invalid or oversized ${label}.`);
    }

    let characterCount = Math.max(0, value.length - 1);
    for (const line of value) {
        if (typeof line !== 'string') {
            throw new Error(`Overleaf returned invalid ${label}.`);
        }
        characterCount += line.length;
        if (characterCount > MAX_REMOTE_DOCUMENT_CHARACTERS) {
            throw new Error(`Overleaf returned oversized ${label}.`);
        }
    }

    return value as string[];
}
