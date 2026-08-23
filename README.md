<p align="center">
  <img src="./images/icon.png" alt="LocalLeaf logo" width="128" height="128">
</p>

# LocalLeaf Community

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

LocalLeaf Community lets you work on Overleaf projects from VS Code while keeping a real local copy of every file. It is the continuation of [LocalLeaf](https://github.com/Teddy-van-Jerry/LocalLeaf), the extension created by Teddy van Jerry, and is now maintained here with contributions from the wider community.

The idea is deliberately simple: write with the local tools you already like, and let LocalLeaf keep the project in step with Overleaf.

## What it can do

- Synchronize files in both directions with Overleaf and self-hosted Overleaf instances
- Show and link remote projects from the VS Code sidebar
- Keep documents updated in real time
- Show collaborators and jump to their cursor positions
- Help resolve local and remote conflicts with a visual diff
- Ignore build output and other generated files through `.leafignore`
- Remove old ignored artifacts from the remote project after confirmation
- Work alongside LaTeX Workshop for local compilation and PDF preview

## Project status

The community edition is being prepared for its first public release. Until that package is available, the safest way to try it is from source:

```powershell
npm install
npm test
npx @vscode/vsce package
```

Install the generated `.vsix` with **Extensions: Install from VSIX...** in VS Code. If the original Marketplace extension is installed, disable or uninstall it first; both versions currently keep the same commands and workspace format so existing LocalLeaf projects continue to work.

## Getting started

1. Open the folder that should contain your local project.
2. Run `LocalLeaf: Login` and authenticate with your Overleaf server.
3. Choose a project from the LocalLeaf sidebar and link it to the folder.
4. Review the first synchronization prompts before choosing which copy to keep.

> [!WARNING]
> Your Overleaf cookies grant access to your account. Only send them to the real server you intend to use, check the URL carefully, and treat them like a password. LocalLeaf stores them in VS Code Secret Storage rather than inside the workspace. Use `LocalLeaf: Logout` if you suspect they were exposed.

## Commands

| Command | What it does |
|---------|--------------|
| `LocalLeaf: Login` | Connects an Overleaf account |
| `LocalLeaf: Logout` | Removes the stored credentials |
| `LocalLeaf: Verify Credentials` | Checks whether the current session is still valid |
| `LocalLeaf: Refresh Cookie` | Replaces an expired session cookie |
| `LocalLeaf: Link Folder to Overleaf Project` | Links the current folder to a project |
| `LocalLeaf: Unlink Folder` | Removes the local project link |
| `LocalLeaf: Sync Now` | Starts a two-way synchronization |
| `LocalLeaf: Pull from Overleaf` | Downloads the latest remote state |
| `LocalLeaf: Push to Overleaf` | Explains the automatic push behavior |
| `LocalLeaf: Edit Ignore Patterns` | Opens `.leafignore` |
| `LocalLeaf: Clean Ignored Files from Overleaf` | Removes ignored remote artifacts after confirmation |
| `LocalLeaf: Show Sync Status` | Shows the connection and synchronization state |
| `LocalLeaf: Set Main Document` | Selects the primary `.tex` document |
| `LocalLeaf: Configure Settings` | Opens the extension settings |
| `LocalLeaf: Jump to Collaborator` | Opens a collaborator's current document and position |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `localleaf.defaultServer` | `https://www.overleaf.com` | Overleaf or self-hosted server URL |
| `localleaf.autoSync` | `true` | Synchronize automatically when local files change |

## The people behind the project

LocalLeaf was started by **Teddy van Jerry (Wuqiong Zhao)**, who designed and built the original extension and maintained its first releases. **Xingyu Chen (Asixa)** later proposed a much broader interface and workflow in PR #3. **Victor Stoica** integrated and hardened parts of that work, fixed synchronization and security issues, and now maintains this continuation.

The full story, including links and a more precise account of the work, is in [ATTRIBUTION.md](ATTRIBUTION.md). The original commit history is preserved, and Asixa's original PR history is kept in the `archive/asixa-pr-3` branch.

## Related projects

LocalLeaf was inspired by [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop), which offers a more deeply integrated Overleaf experience inside VS Code. LocalLeaf takes a different route: it keeps a normal local project that remains usable with Git, LaTeX Workshop, scripts, and any other local tool.

LocalLeaf and LocalLeaf Community are not affiliated with or endorsed by Overleaf.

## License

The project is distributed under the [MIT License](LICENSE). The original copyright notice is kept intact. See [NOTICE](NOTICE) and [ATTRIBUTION.md](ATTRIBUTION.md) for project history and credits.
