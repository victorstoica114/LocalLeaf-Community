import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs, BigIntStats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CONFIG_DIR, DEFAULT_IGNORE_PATTERNS, IGNORE_FILE, SETTINGS_FILE, VAR_MAIN_PDF } from '../consts';
import { isValidProjectSettings, MAX_PROJECT_SETTINGS_BYTES, ProjectSettings, SettingsManager } from './settingsManager';
import { validateServerUrl } from './serverUrl';

const allowedMetadata = new Set(['.git', '.vscode', IGNORE_FILE]);

function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function optionalStat(filename: string): Promise<BigIntStats | undefined> {
    try { return await fs.lstat(filename, { bigint: true }); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function folderPath(uri: vscode.Uri): string {
    if (uri.scheme !== 'file' || uri.query || uri.fragment || !path.isAbsolute(uri.fsPath)) {
        throw new Error('Choose a local folder for the new project.');
    }
    return path.resolve(uri.fsPath);
}

async function inspectAncestors(directory: string): Promise<BigIntStats> {
    let current = directory;
    let selected: BigIntStats | undefined;
    for (;;) {
        const stat = await fs.lstat(current, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('The destination and its parent folders must be real directories, without symbolic links.');
        }
        if (current === directory) selected = stat;
        else if (await optionalStat(path.join(current, CONFIG_DIR))) {
            throw new Error('Choose a folder outside existing LocalLeaf projects.');
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return selected!;
}

async function inspectEntries(directory: string, ownedConfig?: BigIntStats): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        const name = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
        if (name === CONFIG_DIR) {
            if (!ownedConfig) throw new Error('This folder already contains LocalLeaf configuration. Choose another folder.');
            await assertSameDirectory(path.join(directory, entry.name), ownedConfig);
            continue;
        }
        if (!allowedMetadata.has(name)) throw new Error('Choose an empty folder for the new project.');
        if (entry.isSymbolicLink()
            || (name === IGNORE_FILE && !entry.isFile())
            || (name === '.vscode' && !entry.isDirectory())
            || (name === '.git' && !entry.isDirectory() && !entry.isFile())) {
            throw new Error('The destination contains unsupported or linked metadata. Choose another folder.');
        }
    }
}

async function assertSameDirectory(directory: string, expected: BigIntStats): Promise<void> {
    const current = await fs.lstat(directory, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error('The destination folder changed while preparing the project. Choose the folder again.');
    }
}

/** Inspect only; never create, unlink, or switch the user's current workspace. */
export async function inspectProjectCreationFolder(uri: vscode.Uri): Promise<void> {
    const directory = folderPath(uri);
    const original = await inspectAncestors(directory);
    await inspectEntries(directory);
    await assertSameDirectory(directory, original);
}

/**
 * Save a new link without replacing existing configuration. A complete settings
 * file is published with an exclusive hard link, because native rename can
 * replace a concurrently created target on some platforms. Once published,
 * settings remain available to resume an interrupted initial download.
 */
export async function saveNewProjectLink(uri: vscode.Uri, settings: ProjectSettings): Promise<SettingsManager> {
    const snapshot: ProjectSettings = { ...settings, serverUrl: validateServerUrl(settings.serverUrl).url };
    if (!isValidProjectSettings(snapshot) || typeof snapshot.autoSync !== 'boolean') {
        throw new Error('Refusing to save invalid LocalLeaf project settings.');
    }
    const content = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8');
    if (content.byteLength > MAX_PROJECT_SETTINGS_BYTES) throw new Error('LocalLeaf project settings exceed the size limit.');
    const directory = folderPath(uri);
    const original = await inspectAncestors(directory);
    await inspectEntries(directory);
    await assertSameDirectory(directory, original);
    const config = path.join(directory, CONFIG_DIR);
    // This exclusive mkdir also rejects a concurrent project link, even when
    // both callers completed their read-only inspection while the folder was empty.
    await fs.mkdir(config, { mode: 0o700 });
    const ownedConfig = await fs.lstat(config, { bigint: true });
    let published = false;
    const guard = async () => {
        await inspectAncestors(directory);
        await assertSameDirectory(directory, original);
        await assertSameDirectory(config, ownedConfig);
        await inspectEntries(directory, ownedConfig);
    };
    const publish = async (target: string, bytes: Buffer, allowExisting: boolean): Promise<void> => {
        const temporary = path.join(config, `${SETTINGS_FILE}.${randomBytes(12).toString('hex')}.tmp`);
        await guard();
        const handle = await fs.open(temporary, 'wx', 0o600);
        let ownedFile: BigIntStats | undefined;
        try {
            try {
                ownedFile = await handle.stat({ bigint: true });
                await handle.writeFile(bytes);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await guard();
            try {
                await fs.link(temporary, target);
            } catch (error) {
                if (!allowExisting || !(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
                // Preserve a concurrently written ignore file only if it is a
                // regular local file. Never follow a substituted symbolic link.
                const existing = await fs.lstat(target, { bigint: true });
                if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('The existing ignore file is not a regular local file.');
            }
        } finally {
            await assertSameDirectory(directory, original);
            await assertSameDirectory(config, ownedConfig);
            const current = await optionalStat(temporary);
            if (ownedFile && current?.isFile() && current.dev === ownedFile.dev && current.ino === ownedFile.ino) await fs.unlink(temporary);
        }
    };
    try {
        await publish(path.join(config, SETTINGS_FILE), content, false);
        published = true;
        const ignore = Buffer.from(`# LocalLeaf ignore patterns\n${VAR_MAIN_PDF}\n${DEFAULT_IGNORE_PATTERNS.join('\n')}\n`, 'utf8');
        await publish(path.join(directory, IGNORE_FILE), ignore, true);
        await guard();
        const manager = SettingsManager.getInstance(uri);
        const loaded = await manager.load();
        if (!loaded || loaded.serverUrl !== snapshot.serverUrl || loaded.projectId !== snapshot.projectId) {
            throw new Error('The new LocalLeaf configuration could not be loaded. It was kept for recovery.');
        }
        return manager;
    } finally {
        if (!published) {
            await assertSameDirectory(directory, original);
            await assertSameDirectory(config, ownedConfig);
            // Remove only the empty directory created by this call. Existing
            // settings or files added concurrently always prevent removal.
            try { await fs.rmdir(config); }
            catch (error) {
                if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST')) throw error;
            }
        }
    }
}
