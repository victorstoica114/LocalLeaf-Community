const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function getBuildOptions() {
    return {
        absWorkingDir: __dirname,
        entryPoints: { extension: 'src/extension.ts', textMergeWorker: 'src/sync/textMergeWorker.ts' },
        bundle: true,
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        outdir: 'dist',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        logLevel: 'info',
    };
}

async function main() {
    const context = await esbuild.context(getBuildOptions());

    if (watch) {
        await context.watch();
        console.log('[watch] bundle rebuild enabled');
        return;
    }

    await context.rebuild();
    await context.dispose();
}

module.exports = { getBuildOptions };
if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
