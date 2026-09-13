# Testing against an Overleaf server

Use an existing, dedicated test project. Sign in to its server through LocalLeaf in the normal VS Code profile first. The runner uses LocalLeaf's `CredentialManager` and VS Code `SecretStorage` inside an extension development host. It does not read credential databases or export the session.

After installing development dependencies, prepare the runner:

```powershell
node src/test/buildServerIntegration.cjs --project-url 'https://overleaf.example/project/PROJECT_ID' --project-name 'My test project'
```

Replace the URL and project name with the actual values. Preparation only builds files under `.tmp-server-integration/<timestamp>`; it does not contact the server. The output gives a `launch` array and a `report` path. Run the displayed command with each path quoted, for example:

```powershell
code --new-window --disable-extensions --extensionDevelopmentPath 'PATH_TO_EXTENSION' 'PATH_TO_WORKSPACE'
```

The development host starts the tests automatically, then closes its own window. Other VS Code windows can remain open. Do not add `--extensionTestsPath`: VS Code does not support that CLI mode while another instance uses the same profile. The development extension deliberately keeps LocalLeaf's extension ID so normal SecretStorage access remains scoped to LocalLeaf.

Before modifying the project, the runner verifies that its server-reported name matches the supplied name. It creates one timestamped `.localleaf-tests-*` folder and runs two engines with distinct local directories and persistent stores. Their ignore rules include only that folder. It leaves the remote folder and local copies for inspection. The project's existing files are outside the test clients' synchronization scope. Keep other clients' default hidden-folder ignore rule enabled.

The test covers remote creation, an empty second workspace, native VS Code watchers, simultaneous independent edits, restart with offline edits, interrupted confirmation after a server commit, five reconnects, tree refresh without replacing the primary connection, a rename included in a concurrent cleanup-preview snapshot, file and folder creation/deletion, remote rename, ignored directories, a 2.55 MB generated file, sustained synchronization, catch-up of a deliberately missed restoration on window focus, and overlapping edits that require review. During the sustained phase, it asserts zero automatic reconnections and zero project-tree refreshes. The final conflict is intentional: the local and remote versions must remain separate.

The default soak lasts 150 seconds and sends a probe approximately every 15 seconds. Use `--soak-seconds 330` to cover more than five minutes or `--soak-seconds 3600` for a longer run; accepted durations are 150–3600 seconds. A short successful run does not establish multi-hour reliability.

Read `result.json` for completed checks and any failure, and `integration.log` for progress. A passing report has `finished` and no `failure`. The VS Code output channel **LocalLeaf Server Integration** also includes transport diagnostics. Injected disconnection errors are expected in the interruption scenario; pending operation journals and unexplained file errors must be cleared before the final deliberate conflict.

These tests are opt-in. `npm test` remains fully local and uses an HTTP/WebSocket fixture with Overleaf's MIT text transformation implementation.

## Creating a test project

Add `--create-project-test` to the builder command to exercise the graphical project creation controller instead of the two-client soak. The supplied existing project URL/name are verified to identify the intended test server. This mode opens the creation page, supplies the same validated actions as its form, and creates one separate project named `LocalLeaf create test <timestamp>`. A test folder picker selects a fresh OS temporary directory; the production API, folder preparation, download engine, and consent handoff run unchanged. The runner checks the authenticated listing, the local `main.tex` and link, preservation of the result when reopening the page, and automatic upload of a local edit. It leaves the new project and local folder available for inspection and records their locations in `result.json`. Existing project files are not modified.
