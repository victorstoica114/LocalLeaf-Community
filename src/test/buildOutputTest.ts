import { runStandaloneTest } from './standaloneRunner';
/** Exercise a clean build so an old output cannot mask a missing worker bundle. */
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';
import { createTemporaryWorkspace, cleanTemporaryWorkspaces } from './temporaryWorkspace';

async function run(): Promise<void> {
    const directory = await createTemporaryWorkspace('build-output');
    const { getBuildOptions } = require('../../esbuild.js') as { getBuildOptions(): esbuild.BuildOptions };
    await esbuild.build({ ...getBuildOptions(), outdir: directory, sourcemap: false, minify: true });
    assert.deepEqual((await fs.readdir(directory)).sort(), ['extension.js', 'textMergeWorker.js']);
    const worker = new Worker(path.join(directory, 'textMergeWorker.js'), {
        workerData: { base: 'first\nseparator\nlast\n', local: 'FIRST\nseparator\nlast\n', remote: 'first\nseparator\nLAST\n' },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result: unknown = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Packaged merge worker did not answer')), 5000);
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        assert.deepEqual(result, { clean: true, text: 'FIRST\nseparator\nLAST\n' });
    } finally {
        clearTimeout(timer);
        await worker.terminate();
    }
    console.log('Clean build and bundled merge worker passed.');
}

async function main(): Promise<void> {
    try { await run(); } finally { await cleanTemporaryWorkspaces(); }
}
runStandaloneTest(main);
