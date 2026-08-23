# Contributing to LocalLeaf Community

Thank you for taking the time to help. LocalLeaf touches local files and remote projects at the same time, so careful bug reports and testing are just as valuable as code.

## Good places to help

- Reproduce synchronization problems with clear local and remote steps
- Test self-hosted Overleaf versions and unusual project structures
- Improve Windows, macOS, Linux, and remote-workspace compatibility
- Make the sidebar easier to understand and use with a keyboard
- Add regression tests for file creation, deletion, renaming, conflicts, and ignored files
- Improve documentation without assuming that readers already know the project

If a change is large or changes synchronization behavior, please open an issue first. That gives everyone a chance to agree on the intended result before a lot of code is written.

## Local setup

```powershell
npm install
npm test
npm run package
npx @vscode/vsce package
```

Press `F5` in VS Code to open an Extension Development Host. The normal development build writes testable modules to `out/` and the extension bundle to `dist/extension.js`.

The website is kept separately:

```powershell
cd docs/website
npm install
npm run lint
npm run build
```

## Pull requests

Please keep a pull request focused on one problem. Before submitting it:

1. Run `npm test`.
2. Run `npm audit` and mention any remaining findings.
3. Package a VSIX when changing activation, dependencies, or bundled output.
4. Describe how the change was tested, including the operating system and Overleaf server type when relevant.
5. Include screenshots for visible interface changes.
6. Do not include credentials, cookies, project documents, generated PDFs, logs, or local test artifacts.

Security and data-loss risks take priority over convenience. Paths received from a server must be treated as untrusted, destructive remote actions must require clear confirmation, and webview messages must be validated before use.

## Credit and licensing

Contributions are accepted under the repository's MIT license. Please keep existing copyright notices and acknowledge code adapted from another project or pull request. The repository history and [ATTRIBUTION.md](ATTRIBUTION.md) explain how the community continuation relates to the original LocalLeaf project.
