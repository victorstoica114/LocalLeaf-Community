/* Build a development host for an explicitly selected Overleaf test project. */
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const esbuild = require('esbuild');

async function main() {
    const { values } = parseArgs({ options: {
        'project-url': { type: 'string' },
        'project-name': { type: 'string' },
        'soak-seconds': { type: 'string', default: '150' },
        'create-project-test': { type: 'boolean', default: false },
    } });
    if (!values['project-url'] || !values['project-name']) {
        throw new Error('Usage: node src/test/buildServerIntegration.cjs --project-url https://host/project/ID --project-name NAME [--soak-seconds 150]');
    }
    const url = new URL(values['project-url']);
    const match = /^\/project\/([a-f0-9]{24})\/?$/i.exec(url.pathname);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !match) {
        throw new Error('Supply an HTTPS project URL without credentials, query parameters, or fragments');
    }
    const soakSeconds = Number(values['soak-seconds']);
    if (!Number.isInteger(soakSeconds) || soakSeconds < 150 || soakSeconds > 3600) {
        throw new Error('The soak duration must be between 150 and 3600 seconds');
    }
    const repository = path.resolve(__dirname, '../..');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directory = path.join(repository, '.tmp-server-integration', stamp);
    const extensionRoot = path.join(directory, 'extension');
    fs.mkdirSync(extensionRoot, { recursive: true });
    const config = { serverUrl: url.origin, projectId: match[1], projectName: values['project-name'],
        directory, folderName: '.localleaf-tests-' + stamp, soakSeconds,
        createProjectTest: values['create-project-test'] };
    fs.writeFileSync(path.join(extensionRoot, 'run.json'), JSON.stringify(config, null, 2));
    for (const name of ['client-a', 'client-b']) fs.mkdirSync(path.join(directory, name));
    const workspace = path.join(directory, 'integration.code-workspace');
    fs.writeFileSync(workspace, JSON.stringify({
        folders: ['client-a', 'client-b'].map(name => ({ path: path.join(directory, name) })),
        settings: { 'extensions.ignoreRecommendations': true },
    }, null, 2));
    fs.writeFileSync(path.join(extensionRoot, 'package.json'), JSON.stringify({
        name: 'localleaf-community', displayName: 'LocalLeaf Integration Test', publisher: 'victorstoica114',
        version: require('../../package.json').version, engines: { vscode: '^1.85.0' },
        main: './serverIntegrationExtension.js', activationEvents: ['onStartupFinished'],
        capabilities: { untrustedWorkspaces: { supported: false } },
    }, null, 2));
    await esbuild.build({ absWorkingDir: repository,
        entryPoints: { serverIntegrationExtension: values['create-project-test']
            ? 'src/test/createProjectServerExtension.ts' : 'src/test/serverIntegrationExtension.ts',
        textMergeWorker: 'src/sync/textMergeWorker.ts' },
        bundle: true, platform: 'node', target: 'node18', format: 'cjs', external: ['vscode'], outdir: extensionRoot });
    console.log(JSON.stringify({ project: values['project-url'],
        launch: ['code', '--new-window', '--disable-extensions', '--extensionDevelopmentPath', extensionRoot, workspace],
        report: path.join(directory, 'result.json') }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
