import { Worker } from 'worker_threads';
import * as path from 'path';
import { existsSync } from 'fs';
import { diffChars } from 'diff';
import { MAX_REMOTE_DOCUMENT_OPERATIONS } from '../utils/remoteValidation';

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

interface TextSpan { start: number; end: number }
interface EditRegion { oldStart: number; oldEnd: number; newStart: number; newEnd: number }
interface TextAnchor { old: TextSpan; next: TextSpan }

const MAX_FINE_DIFF_WORK = 4 * 1024 * 1024;
const MAX_FINE_EDIT_DISTANCE = 128;
const MAX_ANCHOR_DEPTH = 8;

function splitsSurrogate(text: string, offset: number): boolean {
    return offset > 0 && offset < text.length
        && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
        && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
}

/** Only unique lines are anchors: repeated LaTeX delimiters must not create arbitrary matches. */
function uniqueLines(text: string, start: number, end: number): Map<string, TextSpan | undefined> {
    const result = new Map<string, TextSpan | undefined>();
    while (start < end) {
        const newline = text.indexOf('\n', start);
        const next = newline < 0 ? end : Math.min(end, newline + 1);
        const line = text.slice(start, next);
        result.set(line, result.has(line) ? undefined : { start, end: next });
        start = next;
    }
    return result;
}

/** Patience-style line anchors, ordered on both sides in O(lines log lines) work. */
function matchingAnchors(before: string, after: string, region: EditRegion): TextAnchor[] {
    const oldLines = uniqueLines(before, region.oldStart, region.oldEnd);
    const newLines = uniqueLines(after, region.newStart, region.newEnd);
    const candidates: TextAnchor[] = [];
    for (const [line, old] of oldLines) {
        const next = newLines.get(line);
        if (old && next) candidates.push({ old, next });
    }
    const tails: number[] = [];
    const previous = new Array<number>(candidates.length).fill(-1);
    for (let index = 0; index < candidates.length; index++) {
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (candidates[tails[middle]].next.start < candidates[index].next.start) low = middle + 1;
            else high = middle;
        }
        if (low > 0) previous[index] = tails[low - 1];
        tails[low] = index;
    }
    const result: TextAnchor[] = [];
    for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) result.push(candidates[index]);
    result.reverse();
    // Consecutive equal lines form one anchor, reducing per-block work.
    const blocks: TextAnchor[] = [];
    for (const anchor of result) {
        const last = blocks.at(-1);
        if (last && last.old.end === anchor.old.start && last.next.end === anchor.next.start) {
            last.old.end = anchor.old.end;
            last.next.end = anchor.next.end;
        } else blocks.push({ old: { ...anchor.old }, next: { ...anchor.next } });
    }
    return blocks;
}

/** Keep the largest unchanged gaps if an extremely fragmented edit exceeds the wire format. */
function compactRegions(regions: EditRegion[]): EditRegion[] {
    const maximum = Math.floor(MAX_REMOTE_DOCUMENT_OPERATIONS / 2);
    if (regions.length <= maximum) return regions;
    const gaps = regions.slice(1).map((region, index) => ({
        index, length: region.oldStart - regions[index].oldEnd,
    }));
    gaps.sort((left, right) => right.length - left.length || left.index - right.index);
    const kept = new Set(gaps.slice(0, maximum - 1).map(gap => gap.index));
    const result: EditRegion[] = [{ ...regions[0] }];
    for (let index = 1; index < regions.length; index++) {
        if (kept.has(index - 1)) result.push({ ...regions[index] });
        else {
            const last = result[result.length - 1];
            last.oldEnd = regions[index].oldEnd;
            last.newEnd = regions[index].newEnd;
        }
    }
    return result;
}

/**
 * Produce versioned OT for every saved revision. Fine diff has a deterministic
 * work allowance; expensive gaps fall back to exact replacements between
 * unchanged anchors. No wall-clock deadline can reject a save or change replay.
 * Offsets and common-boundary trimming use UTF-16 without splitting surrogate pairs.
 */
export function textOperations(before: string, after: string): TextOperation[] {
    if (before === after) return [];
    const regions: EditRegion[] = [];
    let remainingWork = MAX_FINE_DIFF_WORK;
    const add = (region: EditRegion) => {
        if (region.oldStart === region.oldEnd && region.newStart === region.newEnd) return;
        const last = regions.at(-1);
        if (last && last.oldEnd === region.oldStart && last.newEnd === region.newStart) {
            last.oldEnd = region.oldEnd;
            last.newEnd = region.newEnd;
        } else regions.push(region);
    };
    const visit = (region: EditRegion, depth: number): void => {
        let { oldStart, oldEnd, newStart, newEnd } = region;
        while (oldStart < oldEnd && newStart < newEnd && before[oldStart] === after[newStart]) {
            oldStart++; newStart++;
        }
        if (splitsSurrogate(before, oldStart) || splitsSurrogate(after, newStart)) { oldStart--; newStart--; }
        while (oldEnd > oldStart && newEnd > newStart && before[oldEnd - 1] === after[newEnd - 1]) {
            oldEnd--; newEnd--;
        }
        if (splitsSurrogate(before, oldEnd) || splitsSurrogate(after, newEnd)) { oldEnd++; newEnd++; }
        if (oldStart === oldEnd && newStart === newEnd) return;
        if (oldStart === oldEnd || newStart === newEnd) { add({ oldStart, oldEnd, newStart, newEnd }); return; }
        const characters = oldEnd - oldStart + newEnd - newStart;
        const editDistance = Math.min(MAX_FINE_EDIT_DISTANCE, Math.floor(remainingWork / characters));
        if (editDistance >= 1) {
            remainingWork -= characters * editDistance;
            const changes = diffChars(before.slice(oldStart, oldEnd), after.slice(newStart, newEnd), {
                maxEditLength: editDistance,
            });
            if (changes) {
                for (const change of changes) {
                    if (change.removed) {
                        add({ oldStart, oldEnd: oldStart + change.value.length, newStart, newEnd: newStart });
                        oldStart += change.value.length;
                    } else if (change.added) {
                        add({ oldStart, oldEnd: oldStart, newStart, newEnd: newStart + change.value.length });
                        newStart += change.value.length;
                    } else { oldStart += change.value.length; newStart += change.value.length; }
                }
                return;
            }
        }
        const anchors = depth < MAX_ANCHOR_DEPTH
            ? matchingAnchors(before, after, { oldStart, oldEnd, newStart, newEnd }) : [];
        if (!anchors.length) { add({ oldStart, oldEnd, newStart, newEnd }); return; }
        for (const anchor of anchors) {
            visit({ oldStart, oldEnd: anchor.old.start, newStart, newEnd: anchor.next.start }, depth + 1);
            oldStart = anchor.old.end;
            newStart = anchor.next.end;
        }
        visit({ oldStart, oldEnd, newStart, newEnd }, depth + 1);
    };
    visit({ oldStart: 0, oldEnd: before.length, newStart: 0, newEnd: after.length }, 0);
    const result: TextOperation[] = [];
    for (const region of compactRegions(regions)) {
        if (region.oldStart < region.oldEnd) result.push({ p: region.newStart, d: before.slice(region.oldStart, region.oldEnd) });
        if (region.newStart < region.newEnd) result.push({ p: region.newStart, i: after.slice(region.newStart, region.newEnd) });
    }
    return result;
}
