/** Isolated local project creation must preserve existing folders and metadata. */
import { TestUri } from './nativeSyncFixture';
import { inspectProjectCreationFolder, saveNewProjectLink } from '../utils/projectCreationFolder';
import { SettingsManager } from '../utils/settingsManager';
import type { ProjectSettings } from '../utils/settingsManager';
import type { Uri } from 'vscode';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { runStandaloneTest } from './standaloneRunner';

const uri = (directory: string) => TestUri.file(directory) as unknown as Uri;
const project = (projectId = 'new-project'): ProjectSettings => ({
    serverUrl: 'https://example.invalid/', projectId, projectName: 'New project', autoSync: true,
    mainTex: 'main.tex', mainPdf: 'main.pdf',
});

runStandaloneTest(async () => {
    // Repository-root fixtures would themselves be nested in the developer's
    // linked LocalLeaf project. Use an owned system temp directory instead.
    const temporaryRoot = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temporaryRoot, 'localleaf-folder-audit-'));
    const originalLink = fs.link;
    const originalMkdir = fs.mkdir;
    const previousCurrent = SettingsManager.getCurrentInstance()?.getWorkspaceFolder();
    const folder = async (name: string) => {
        const directory = path.join(root, name);
        await fs.mkdir(directory);
        return directory;
    };
    try {
        const destination = await folder('empty');
        await inspectProjectCreationFolder(uri(destination));
        const current = await folder('current-workspace');
        SettingsManager.setCurrentWorkspaceFolder(uri(current));
        const currentManager = SettingsManager.getCurrentInstance();
        const manager = await saveNewProjectLink(uri(destination), project());
        assert.equal(manager.getWorkspaceFolder().fsPath, destination);
        assert.equal(manager.getSettings()?.projectId, 'new-project');
        assert.equal(manager.getSettings()?.serverUrl, 'https://example.invalid');
        assert.equal(SettingsManager.getCurrentInstance(), currentManager, 'creating a link must not switch the active workspace');
        assert.deepEqual(await fs.readdir(current), [], 'the existing workspace must remain untouched');
        const settingsPath = path.join(destination, '.localleaf', 'settings.json');
        const saved = await fs.readFile(settingsPath, 'utf8');
        assert.equal(JSON.parse(saved).projectId, 'new-project');
        assert.match(await fs.readFile(path.join(destination, '.leafignore'), 'utf8'), /\$MAIN_PDF/);
        assert.deepEqual(await fs.readdir(path.join(destination, '.localleaf')), ['settings.json']);
        await assert.rejects(saveNewProjectLink(uri(destination), project('another-project')), /already contains LocalLeaf/);
        assert.equal(await fs.readFile(settingsPath, 'utf8'), saved);

        const metadata = await folder('metadata');
        await fs.mkdir(path.join(metadata, '.git'));
        await fs.writeFile(path.join(metadata, '.git', 'config'), 'user git config');
        await fs.mkdir(path.join(metadata, '.vscode'));
        await fs.writeFile(path.join(metadata, '.vscode', 'settings.json'), '{"existing":true}');
        await fs.writeFile(path.join(metadata, '.leafignore'), 'custom/**\n');
        await inspectProjectCreationFolder(uri(metadata));
        await saveNewProjectLink(uri(metadata), project());
        assert.equal(await fs.readFile(path.join(metadata, '.leafignore'), 'utf8'), 'custom/**\n');
        assert.equal(await fs.readFile(path.join(metadata, '.git', 'config'), 'utf8'), 'user git config');
        assert.equal(await fs.readFile(path.join(metadata, '.vscode', 'settings.json'), 'utf8'), '{"existing":true}');
        const worktree = await folder('git-worktree');
        await fs.writeFile(path.join(worktree, '.git'), 'gitdir: ../metadata/.git/worktrees/test');
        await inspectProjectCreationFolder(uri(worktree));

        const nonempty = await folder('nonempty');
        await fs.writeFile(path.join(nonempty, 'main.tex'), 'existing contents');
        await assert.rejects(inspectProjectCreationFolder(uri(nonempty)), /empty folder/);
        await assert.rejects(saveNewProjectLink(uri(nonempty), project()), /empty folder/);
        assert.equal(await fs.readFile(path.join(nonempty, 'main.tex'), 'utf8'), 'existing contents');
        const invalidConfig = await folder('invalid-config');
        await fs.mkdir(path.join(invalidConfig, '.localleaf'));
        await assert.rejects(inspectProjectCreationFolder(uri(invalidConfig)), /already contains LocalLeaf/);
        const linkedChild = path.join(destination, 'nested');
        await fs.mkdir(linkedChild);
        await assert.rejects(inspectProjectCreationFolder(uri(linkedChild)), /outside existing LocalLeaf/);
        const invalidChild = path.join(invalidConfig, 'nested');
        await fs.mkdir(invalidChild);
        await assert.rejects(inspectProjectCreationFolder(uri(invalidChild)), /outside existing LocalLeaf/);
        await assert.rejects(inspectProjectCreationFolder({ scheme: 'vscode-remote', fsPath: destination } as Uri), /local folder/);
        await assert.rejects(inspectProjectCreationFolder(uri(path.join(root, 'missing'))), { code: 'ENOENT' });
        await assert.rejects(inspectProjectCreationFolder(uri(path.join(nonempty, 'main.tex'))), /real directories/);

        const target = await folder('junction-target');
        const junction = path.join(root, 'junction');
        await fs.symlink(target, junction, 'junction');
        await assert.rejects(inspectProjectCreationFolder(uri(junction)), /symbolic links/);
        await fs.mkdir(path.join(target, 'child'));
        await assert.rejects(inspectProjectCreationFolder(uri(path.join(junction, 'child'))), /symbolic links/);
        const linkedMetadata = await folder('linked-metadata');
        await fs.symlink(target, path.join(linkedMetadata, '.git'), 'junction');
        await assert.rejects(inspectProjectCreationFolder(uri(linkedMetadata)), /linked metadata/);

        const concurrent = await folder('concurrent-callers');
        const results = await Promise.allSettled([
            saveNewProjectLink(uri(concurrent), project('first')),
            saveNewProjectLink(uri(concurrent), project('second')),
        ]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        const stored = JSON.parse(await fs.readFile(path.join(concurrent, '.localleaf', 'settings.json'), 'utf8'));
        const winner = results.find(result => result.status === 'fulfilled');
        assert.ok(winner && winner.status === 'fulfilled');
        assert.equal(stored.projectId, winner.value.getSettings()?.projectId);

        const race = await folder('concurrent-settings');
        const raceSettings = path.join(race, '.localleaf', 'settings.json');
        fs.link = async (source, targetPath) => {
            if (targetPath === raceSettings) {
                assert.equal(JSON.parse(await fs.readFile(source, 'utf8')).projectId, 'ours',
                    'the unpublished configuration must already contain complete JSON');
                await fs.writeFile(raceSettings, '{"ownedBy":"another caller"}', { flag: 'wx' });
            }
            return originalLink(source, targetPath);
        };
        await assert.rejects(saveNewProjectLink(uri(race), project('ours')), { code: 'EEXIST' });
        fs.link = originalLink;
        assert.equal(await fs.readFile(raceSettings, 'utf8'), '{"ownedBy":"another caller"}');
        assert.deepEqual(await fs.readdir(path.dirname(raceSettings)), ['settings.json'], 'only the helper-owned temporary file may be removed');

        const changed = await folder('changed-destination');
        fs.mkdir = (async (directory: string, options?: Parameters<typeof fs.mkdir>[1]) => {
            if (directory === path.join(changed, '.localleaf')) await fs.writeFile(path.join(changed, 'user.txt'), 'concurrent edit');
            return originalMkdir(directory, options);
        }) as typeof fs.mkdir;
        await assert.rejects(saveNewProjectLink(uri(changed), project()), /empty folder/);
        fs.mkdir = originalMkdir;
        assert.deepEqual(await fs.readdir(changed), ['user.txt'], 'failed preparation must remove only its empty generated config directory');
        assert.equal(await fs.readFile(path.join(changed, 'user.txt'), 'utf8'), 'concurrent edit');

        const invalidSettings = await folder('invalid-settings');
        await assert.rejects(saveNewProjectLink(uri(invalidSettings), { ...project(), projectId: '' }), /invalid LocalLeaf/);
        assert.deepEqual(await fs.readdir(invalidSettings), []);
        console.log('Project creation folder validation, metadata preservation, and exclusive publication tests passed.');
    } finally {
        fs.link = originalLink;
        fs.mkdir = originalMkdir;
        SettingsManager.setCurrentWorkspaceFolder(previousCurrent);
        const absolute = path.resolve(root);
        if (path.dirname(absolute) !== temporaryRoot || !path.basename(absolute).startsWith('localleaf-folder-audit-')) {
            throw new Error('Refusing to clean an unowned temporary directory');
        }
        if ((await fs.lstat(absolute)).isSymbolicLink()) throw new Error('The test directory was replaced');
        await fs.rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
});
