import * as path from 'path';
import { promises as fs } from 'fs';

const repositoryRoot = path.resolve(__dirname, '../..');
const workspaces = new Set<string>();

export async function createTemporaryWorkspace(label: string): Promise<string> {
    if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid test workspace label');
    const directory = await fs.mkdtemp(path.join(repositoryRoot, `.tmp-${label}-`));
    workspaces.add(directory);
    return directory;
}

export async function cleanTemporaryWorkspaces(): Promise<void> {
    for (const directory of workspaces) {
        const absolute = path.resolve(directory);
        if (path.dirname(absolute) !== repositoryRoot || !path.basename(absolute).startsWith('.tmp-')) {
            throw new Error('Refusing to remove a path outside the generated test workspaces');
        }
        const stat = await fs.lstat(absolute).catch(error => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
        });
        if (stat?.isSymbolicLink()) throw new Error('Refusing to traverse a replaced test workspace');
        await fs.rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        workspaces.delete(directory);
    }
}
