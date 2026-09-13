import { Worker } from 'worker_threads';
import * as path from 'path';
import { existsSync } from 'fs';
import { diffChars, diffLines } from 'diff';

export type TextOperation = { p: number; i?: string; d?: string };
export type MergeResult = { clean: true; content: Uint8Array } | { clean: false; reason: string };
const MAX_BYTES = 2 * 1024 * 1024;
let running = 0;

/** A hard worker deadline bounds quadratic repeated-line inputs. No partial merge escapes. */
export async function mergeText(base: Uint8Array | undefined, local: Uint8Array, remote: Uint8Array,
    timeoutMs = 1500): Promise<MergeResult> {
    if (base === undefined) return { clean: false, reason: 'No common ancestor' };
    if ([base, local, remote].some(value => value.byteLength > MAX_BYTES)) {
        return { clean: false, reason: 'Document exceeds automatic merge budget' };
    }
    let input: { base: string; local: string; remote: string };
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        input = { base: decoder.decode(base), local: decoder.decode(local), remote: decoder.decode(remote) };
        if (Object.values(input).some(value => value.includes('\0'))) throw new Error('Binary text');
    } catch { return { clean: false, reason: 'Content is not UTF-8 text' }; }
    if (input.local === input.remote) return { clean: true, content: local };
    if (input.base === input.local) return { clean: true, content: remote };
    if (input.base === input.remote) return { clean: true, content: local };
    if (running >= 2) return { clean: false, reason: 'Automatic merge workers are busy' };
    running++;
    return new Promise(resolve => {
        // esbuild puts the worker next to extension.js; tsc retains sync/.
        const filename = path.join(__dirname, 'textMergeWorker.js');
        let worker: Worker;
        let timer: NodeJS.Timeout;
        let settled = false;
        const finish = (result: MergeResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (worker) void worker.terminate();
            running--;
            resolve(result);
        };
        try {
            if (!existsSync(filename)) throw new Error('Merge worker is missing');
            worker = new Worker(filename, { workerData: input,
                resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
            timer = setTimeout(() => finish({ clean: false, reason: 'Automatic merge exceeded its time budget' }), timeoutMs);
            worker.once('message', result => finish(result?.clean === true && typeof result.text === 'string'
                ? { clean: true, content: new TextEncoder().encode(result.text) }
                : { clean: false, reason: 'Both sides changed the same lines' }));
            worker.once('error', () => finish({ clean: false, reason: 'Automatic merge worker failed' }));
            worker.once('exit', () => finish({ clean: false, reason: 'Automatic merge worker stopped' }));
        } catch { finish({ clean: false, reason: 'Automatic merge worker could not start' }); }
    });
}

/** Overleaf offsets are UTF-16 code units, not jsdiff's code-point token counts. */
export function textOperations(before: string, after: string): TextOperation[] {
    if (before === after) return [];
    if (!before) return [{ p: 0, i: after }];
    if (!after) return [{ p: 0, d: before }];
    const changes = diffChars(before, after, { timeout: 50, maxEditLength: 8192 })
        ?? diffLines(before, after, { timeout: 50, maxEditLength: 8192 });
    if (!changes) throw new Error('Document diff exceeded its budget; local changes are preserved');
    let position = 0;
    const result: TextOperation[] = [];
    for (const change of changes) {
        if (change.removed) result.push({ p: position, d: change.value });
        else {
            if (change.added) result.push({ p: position, i: change.value });
            position += change.value.length;
        }
    }
    return result;
}
