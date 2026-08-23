const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
    const context = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        outfile: 'dist/extension.js',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        logLevel: 'info',
    });

    if (watch) {
        await context.watch();
        console.log('[watch] bundle rebuild enabled');
        return;
    }

    await context.rebuild();
    await context.dispose();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
