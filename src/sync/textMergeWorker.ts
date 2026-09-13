import { parentPort, workerData } from 'worker_threads';
import { diff3Merge } from 'node-diff3';

// Arrays retain every whitespace character, including the final newline.
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const input = workerData as { base: string; local: string; remote: string };
const result = diff3Merge(lines(input.local), lines(input.base), lines(input.remote), {
    excludeFalseConflicts: true,
});
parentPort!.postMessage(result.some(region => 'conflict' in region)
    ? { clean: false }
    : { clean: true, text: result.map(region => region.ok?.join('') || '').join('') });
