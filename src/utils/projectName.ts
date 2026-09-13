/** Overleaf project titles have a separate limit from filesystem entries. */
export const MAX_PROJECT_NAME_LENGTH = 150;

export function validateProjectName(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Enter a project name.');
    if (/[\x00-\x1f\x7f-\x9f]/.test(value)) {
        throw new Error('Project names cannot contain control characters.');
    }
    const name = value.trim();
    if (!name) throw new Error('Enter a project name.');
    if (name.length > MAX_PROJECT_NAME_LENGTH) {
        throw new Error(`Project names must be ${MAX_PROJECT_NAME_LENGTH} characters or fewer.`);
    }
    if (/[\\/]/.test(name)) throw new Error('Project names cannot contain / or \\ characters.');
    return name;
}
