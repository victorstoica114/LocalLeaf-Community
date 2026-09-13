/** Node can exit successfully while an awaited Promise has no live event source. */
export function runStandaloneTest(run: () => Promise<void>): void {
    const incomplete = () => {
        console.error('Test runner exited before its asynchronous checks completed.');
        process.exitCode = 1;
    };
    process.once('beforeExit', incomplete);
    void Promise.resolve().then(run).then(() => {
        process.removeListener('beforeExit', incomplete);
    }, error => {
        process.removeListener('beforeExit', incomplete);
        console.error(error);
        process.exitCode = 1;
    });
}
