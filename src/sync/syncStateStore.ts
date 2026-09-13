import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { normalizeProjectPath } from '../utils/pathSafety';

export interface SyncStateEntry {
    path: string;
    id: string;
    type: 'doc' | 'file' | 'folder';
    hash?: string;
    content?: string; // base64; absent means unknown/evicted, distinct from an empty ancestor
    version?: number;
    intent?: { kind: 'write'; before: string; desired: string; local: string; version: number;
        sources: string[]; confirmed?: boolean }
        | { kind: 'delete' }
        | { kind: 'replace'; desiredHash: string; backupPath: string };
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_RECORD_BYTES = 48 * 1024 * 1024;
const MAX_LOADED_BYTES = 256 * 1024 * 1024;

/** Per-workspace/project records. Atomic replacement leaves either the old or the new ancestor. */
export class SyncStateStore {
    private readonly directory: string;
    private tail: Promise<void> = Promise.resolve();
    private failure?: Error;
    readonly entries = new Map<string, SyncStateEntry>();
    constructor(root: string, identity: string, private readonly onError: (error: Error) => void) {
        this.directory = path.join(root, 'sync-v1', digest(identity));
    }

    async load(): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true });
        const files = await fs.readdir(this.directory);
        if (files.length > 100_000) throw new Error('Too many synchronization state records');
        const loaded = new Map<string, SyncStateEntry>();
        let total = 0;
        for (const filename of files) {
            if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
            const location = path.join(this.directory, filename);
            const stat = await fs.lstat(location);
            if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error('Invalid synchronization state file');
            total += stat.size;
            if (total > MAX_LOADED_BYTES) throw new Error('Synchronization state exceeds its storage budget');
            const record = JSON.parse(await fs.readFile(location, 'utf8')) as { schema: number; entry: SyncStateEntry };
            const entry = record.entry;
            if (record.schema !== 1 || !entry || typeof entry.path !== 'string'
                || normalizeProjectPath(entry.path) !== entry.path || digest(entry.path) + '.json' !== filename
                || typeof entry.id !== 'string' || !['doc', 'file', 'folder'].includes(entry.type)
                || (entry.version !== undefined && (!Number.isSafeInteger(entry.version) || entry.version < 0))
                || (entry.hash !== undefined && !/^[a-f0-9]{64}$/.test(entry.hash))
                || (entry.content !== undefined && (typeof entry.content !== 'string'
                    || createHash('sha256').update(Buffer.from(entry.content, 'base64')).digest('hex') !== entry.hash))) {
                throw new Error('Invalid synchronization ancestor; refusing to guess a replacement');
            }
            if (entry.intent) {
                const intent = entry.intent;
                const replacement = intent.kind === 'replace' && typeof intent.backupPath === 'string'
                    && normalizeProjectPath(intent.backupPath, false) === intent.backupPath
                    && /^[a-f0-9]{64}$/.test(intent.desiredHash);
                if (!replacement && intent.kind !== 'delete' && (intent.kind !== 'write'
                    || !Number.isSafeInteger(intent.version) || intent.version < 0
                    || ![intent.before, intent.desired, intent.local].every(value => typeof value === 'string'
                        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
                    || !Array.isArray(intent.sources) || intent.sources.length > 32
                    || intent.sources.some(source => typeof source !== 'string' || !source || source.length > 1024)
                    || (intent.confirmed !== undefined && typeof intent.confirmed !== 'boolean'))) {
                    throw new Error('Invalid pending synchronization operation; refusing to replay it');
                }
            }
            loaded.set(entry.path, entry);
        }
        // Reject a damaged snapshot without exposing only some of its ancestors.
        this.entries.clear();
        for (const [projectPath, entry] of loaded) this.entries.set(projectPath, entry);
    }

    put(entry: SyncStateEntry): void {
        const previous = this.entries.get(entry.path);
        // Reconciliation often observes the same ancestor. Avoid rewriting and
        // fsyncing every unchanged file, while always journaling pending writes.
        if (!this.failure && previous && previous.intent === undefined && entry.intent === undefined
            && previous.id === entry.id && previous.type === entry.type && previous.hash === entry.hash
            && previous.content === entry.content && previous.version === entry.version) return;
        const copy = { ...entry, intent: entry.intent?.kind === 'write'
            ? { ...entry.intent, sources: [...entry.intent.sources] } : entry.intent ? { ...entry.intent } : undefined };
        this.entries.set(copy.path, copy);
        this.enqueue(async () => {
            const contents = JSON.stringify({ schema: 1, entry: copy });
            if (Buffer.byteLength(contents) > MAX_RECORD_BYTES) throw new Error('Synchronization record exceeds its storage budget');
            const destination = path.join(this.directory, digest(copy.path) + '.json');
            const temporary = path.join(this.directory, randomUUID() + '.tmp');
            try {
                const file = await fs.open(temporary, 'wx', 0o600);
                try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
                await fs.rename(temporary, destination);
            } finally { await fs.unlink(temporary).catch(() => undefined); }
        });
    }

    delete(projectPath: string): void {
        this.entries.delete(projectPath);
        this.enqueue(() => fs.rm(path.join(this.directory, digest(projectPath) + '.json'), { force: true }));
    }

    private enqueue(action: () => Promise<void>): void {
        this.tail = this.tail.then(action).catch(error => {
            this.failure = error instanceof Error ? error : new Error(String(error));
            this.onError(this.failure);
        });
    }

    async flush(): Promise<void> {
        await this.tail;
        if (this.failure) throw this.failure;
    }
}
