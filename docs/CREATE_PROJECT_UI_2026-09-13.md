# Graphical project creation — 0.2.15

Create New Project opens a dedicated VS Code editor page. The page contains the project name, editable server URL, account verification and sign-in controls, blank template preview, and optional local download. A native folder picker selects the destination. Validation, progress, errors, recovery and success actions remain in the page.

The controller retains the draft and result when the editor tab closes. Creation sends one POST. An uncertain server outcome requires checking Overleaf before starting another project. If local setup fails after creation, Retry Local Setup downloads the same project without repeating the creation request. Expired sessions can be replaced through the graphical Account panel while retaining the result and selected server.

Local destinations must be empty apart from supported editor/Git/ignore metadata. Existing links, nested LocalLeaf projects and symbolic links are rejected. Configuration is published without overwriting another file or concurrent link. A published link remains available for recovery. Explicit create-and-download consent is stored for the exact local folder, server and returned project ID and transferred when the folder opens in another window.

## Validation

- The generated webview script is tested for validation, input retention, pending actions, recovery, message parsing and panel lifecycle.
- Controller tests cover concurrent clicks, stale draft/account replies, authentication loss, uncertain POST results, failed local setup, retries, conflicting folder links and disposal during asynchronous steps.
- Native filesystem tests cover destination validation, symbolic links, existing metadata, concurrent publication and preservation of files written during preparation.
- Authorization tests cover exact-target matching, one-time transfer, persistence failures and bounded pending records.
- The actual HTML was rendered in isolated Chromium profiles at 1200 × 960 and 520 × 1350 and visually inspected. The temporary screenshot artifacts were removed during the subsequent local cleanup.

The live run completed at `2026-09-13T09:26:59.294Z`, with all eight checks passing. It used the normal LocalLeaf SecretStorage session, the actual creation controller and webview, a test folder picker, the production API, folder preparation and synchronization engine. It verified creation, download, exact consent, reopening without duplicate creation, the authenticated project listing and automatic upload of a local edit after restarting the sync engine.

The test created `LocalLeaf create test 2026-09-13T09-26-37-654Z`. The temporary run report and old local copies were removed during cleanup. The retained local project is in the ignored `test/localleaf` folder; its private connection metadata is not committed. The existing test project's files were not modified. See [SERVER_INTEGRATION.md](SERVER_INTEGRATION.md) to repeat the opt-in run.

The complete `npm test` suite passed, including TypeScript, ESLint, clean packaging/worker output and the existing synchronization regressions. The installed candidate `localleaf-community-0.2.15.vsix` contained 14 files (253.99 KB). Its manifest, exact bundles, licenses and source/test/private-workspace exclusions were checked. The installed extension's version and both bundle hashes match the verified build. Reloading an existing VS Code window activates the update.

Installed candidate VSIX SHA-256 (before release documentation was finalized): `a82ee672137440d3abe59d38f917a3c762c92126646fa93e9cf94a65eddf8d03`.

The release package was rebuilt after finalizing the changelog. It contains 14 files (258858 bytes), with runtime bundles identical to the tested and installed candidate. Release VSIX SHA-256: `d87289334a453e94d828c4ce7642fc8b6016b45b23d00cbb179ac6abf04dd212`.
