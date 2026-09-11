# Changelog

All notable changes to LocalLeaf Community will be documented in this file.

## [0.2.10] - 2026-09-11

### Fixed

- Download new and restored remote files automatically when no local copy exists, including the initial pull
- Accept Overleaf's null parent-folder marker for root-level creation, restoration, and move events
- Preserve conflicting local copies and unsaved editors, and recheck local changes before applying an incoming file

[0.2.10]: https://github.com/victorstoica114/LocalLeaf-Community/compare/v0.2.9...v0.2.10

## [0.2.9] - 2026-09-11

### Fixed

- Allow 30 seconds for connection establishment and two minutes for project metadata instead of aborting both after five seconds
- Retry temporary initial connection failures automatically, with bounded attempts and cancellation when the workspace closes
- Abort pending HTTP handshakes and transport timers when a connection is discarded, preventing abandoned requests from opening sockets later
- Report HTTP handshake status and connection stages instead of hiding transport failures behind generic timeouts
- Avoid repeating the complete real-time error inside the HTTP fallback explanation

[0.2.9]: https://github.com/victorstoica114/LocalLeaf-Community/compare/v0.2.4...v0.2.9

## [0.2.8] - 2026-09-10

### Fixed

- Apply ignored directory patterns such as `/analysis/` to all descendants, including direct file events and bulk synchronization
- Include fully ignored folders in remote cleanup while preserving explicitly included descendants and the main document
- Preview ignored and remote-only entries in Clean Remote Files, then delete only selected identities that still qualify, preserving local content

## [0.2.7] - 2026-09-10

### Fixed

- Truncate long sidebar status messages and file paths with an ellipsis, keeping the full text available on hover

## [0.2.6] - 2026-09-10

### Fixed

- Upload large text files through the file upload endpoint instead of sending updates above Overleaf's default editable-document limit (2 Mi characters)
- Convert existing oversized documents using a verified replacement and rollback copy, preserving local content, conflict decisions, and the compilation root
- Respect the document or file storage type returned by Overleaf's upload endpoint

## [0.2.5] - 2026-09-10

### Fixed

- Reconnect lost real-time sessions when using Sync Now, Retry sync, or Pull from Overleaf, even after an error replaces the disconnected status
- Allow up to two minutes for large document reads without extending the deadline for ordinary Socket.IO acknowledgements
- Automatically reconnect and resume interrupted pulls, with two retries and a refreshed project tree while retaining local changes and conflict baselines
- Recover idle real-time disconnections automatically and discard queued events from the previous connection
- Explain connection loss when a server supplies its project tree only through Socket.IO
- Keep an interrupted pull from subscribing documents or reporting completion after a workspace switch

## [0.2.4] - 2026-09-07

### Added

- Added isolated browser-assisted login with browser selection, cancellation, session verification, and re-authentication in the Account panel

### Changed

- Keep stored sessions unverified until a successful authenticated request, and preserve existing credentials when login is cancelled or fails
- Keep the sidebar responsive while initial synchronization waits for a user decision

### Fixed

- Track document versions so queued or duplicate edits cannot be applied twice after a pull
- Detect concurrent local and remote document edits before automatic uploads, and preserve changes made while a conflict prompt is open
- Preserve local-only, ignored and unsaved files when a remote folder is removed or moved out of synchronization; ask before deleting modified copies
- Keep document subscriptions active across manual pulls and refresh the project tree for HTTP synchronization
- Retry identical saved content after a failed upload instead of suppressing it as an echo
- Upload plain Uint8Array, sliced arrays and empty binary files without multipart stream errors
- Wait for document updates to be applied before marking uploads complete, including edits transformed by the server
- Show a concise connection error for unavailable project servers and keep the LocalLeaf menu accessible
- Allow selecting another browsing server from Connection Settings without deleting the previous session or changing existing project links
- Keep server drafts and newly loaded projects intact when an older request finishes in the background
- Replace HTML error pages with readable messages and route login redirects to re-authentication

[0.2.4]: https://github.com/victorstoica114/LocalLeaf-Community/compare/v0.2.3...v0.2.4

## [0.2.3] - 2026-08-28

### Changed

- Made the Visual Studio Marketplace the primary installation path on the project website while retaining GitHub Releases for manual and offline installs
- Used workspace-folder URIs for settings and ignore-file watchers so they remain correct across Windows and non-file workspace schemes

### Fixed

- Used the linked project's server when resolving the account shown in the status bar
- Preserved the last valid project metadata and file tree when Overleaf returns malformed refresh data
- Prevented cursor-tracking listeners from being registered after their synchronization session has already been disposed
- Kept active `.leafignore` patterns unchanged when validating or writing an updated ignore file fails

[0.2.3]: https://github.com/victorstoica114/LocalLeaf-Community/compare/v0.2.2...v0.2.3

## [0.2.2] - 2026-08-27

### Changed

- Represented Asixa's PR #3 authorship on the default branch, preserved the original series in an archive branch, documented both author names, Xingyu Chen and RFDT, and added a mailmap entry that groups them under Xingyu Chen
- Excluded this development checkout's LocalLeaf link metadata from Git and VSIX packages
- Added a public contributor-integration audit covering every upstream pull request and all 34 commits in Asixa's PR #3
- Reimplemented the safe parts of Asixa's comment-removal and editor-recovery work with explicit confirmation, bounded input, and undoable VS Code edits

### Fixed

- Added automatic negotiation between legacy and query-based Overleaf Socket.IO project joins, restoring real-time synchronization with current self-hosted Community Edition servers
- Preserved synchronization event handlers when switching Socket.IO protocols and surfaced the real-time connection cause when HTTP fallback is also unavailable
- Preserved dirty editor buffers during remote content, rename, move, delete, and full-pull operations
- Kept live document subscriptions active after manual pulls and surfaced document-watch failures instead of silently reporting success
- Added per-workspace synchronization authorization and strengthened remote path, entity, OT, collaborator, webview-message, and account-cookie validation
- Bounded pending remote events, OT payload memory, remote project trees, and recursive local project scans
- Made `localleaf.autoSync` and the linked-project `autoSync` flag actually disable watcher-triggered local uploads
- Prevented server-provided account fields from being interpreted as Markdown in status tooltips
- Removed legacy synchronous child-process XHR and JSON `eval` fallbacks, rejected credential-preserving redirects, and bounded legacy XHR responses
- Revalidated public project-link command arguments against the authenticated server and required explicit synchronization approval for every folder
- Preserved unknown or legacy files under `.localleaf` when unlinking a workspace instead of deleting the metadata directory recursively
- Kept failed local creates out of the synchronized baseline and rejected impossible entity types returned by the file-upload endpoint
- Rejected remote rename and move events that collide with another entity or move a folder into its own subtree
- Bounded `.localleaf/settings.json` and `.leafignore` input sizes as well as ignore-pattern count and length
- Bounded local filesystem reads and upload payloads, including text-document limits before OT generation
- Replaced retained binary synchronization payloads with zero-byte markers while keeping content hashes for echo detection
- Capped retained OT document baselines at 64 MiB and added hash-backed authoritative recovery for evicted baselines
- Capped retained conflict-diff content at 20 MiB per synchronization session
- Bounded login inputs and authentication metadata, rejected unsafe header characters, and copied identities defensively
- Bounded project-list responses and validated HTTP route, mutation, and project metadata IDs at the transport boundary
- Preserved ignored and local-only files when a synchronized remote folder is deleted or moved out of scope
- Prevented full pulls from creating protected or ignored remote directories locally
- Kept failed local changes eligible for retry instead of caching them as successful synchronization echoes
- Replaced retained Socket.IO echo payloads with bounded SHA-256 fingerprints and capped stale suppression state
- Closed stalled Socket.IO connections on event timeouts and cleared legacy ACK callbacks and queued payloads on disconnect
- Tracked binary replacement backups under their real temporary paths and kept them until the uploaded replacement identity is verified
- Enforced inbound WebSocket payload and buffering limits before legacy Socket.IO messages are parsed
- Coalesced rapid cursor updates and released cursor-tracking state across disconnects and reconnections
- Capped concurrent Socket.IO events awaiting acknowledgements and closed connections that exceed the limit
- Required a verified remote entity identity before treating new binary uploads as synchronized
- Closed server-forced socket sessions immediately and bounded live-watch failure diagnostics
- Made the legacy Socket.IO client independent of CommonJS parent-module state so the bundled production extension can establish real-time connections
- Made the legacy Socket.IO dependency patch apply cleanly during fresh installs and release builds

[0.2.2]: https://github.com/victorstoica114/LocalLeaf-Community/compare/v0.2.1...v0.2.2

## [0.2.1] - 2026-08-23

### Added

- Added contributor guidance for development, testing, and pull requests
- Added a regression check that loads the production entry-point bundle

### Changed

- Bundled the extension and its runtime dependencies into one minified JavaScript file with esbuild
- Reduced the VSIX by excluding intermediate TypeScript output, development dependencies, and unused images
- Updated the development launch configuration to run the bundled entry point

[0.2.1]: https://github.com/victorstoica114/LocalLeaf-Community/compare/v0.2.0...v0.2.1

## [0.2.0] - 2026-08-23

This is the first release maintained from the LocalLeaf Community repository.

### Added

- Added a redesigned project browser and workspace sidebar based on ideas and code from Asixa's PR #3
- Added clearer account, connection, synchronization, conflict, collaborator, and ignored-file controls
- Added a confirmed cleanup command for removing files that are newly covered by `.leafignore` from the remote project
- Added independent LocalLeaf Community branding, project attribution, and third-party notices

### Changed

- Continued development in an independent community repository while preserving the original MIT license and project history
- Improved accessibility, keyboard behavior, zoom handling, loading states, and feedback throughout the sidebar
- Hardened synchronization, API handling, credential flows, path validation, and webview message handling
- Updated dependencies and package overrides to address known security advisories

### Fixed

- Fixed synchronization races around file creation, binary files, remote updates, and filesystem watcher echoes
- Fixed Windows path handling that could incorrectly reject valid files as being outside the workspace
- Fixed project activation and linked-workspace detection after startup
- Fixed cleanup of ignored files on self-hosted Overleaf instances and nested project folders

[0.2.0]: https://github.com/victorstoica114/LocalLeaf-Community/compare/v0.1.3...v0.2.0

## [0.1.3] - 2026-01-04

### Added

- Graceful handling of Overleaf cookie expiration
  - Login status bar shows yellow warning with "(expired)" when session expires
  - Toast notification with "Refresh Cookie" button when 403/401 errors detected
  - "Refresh Cookie" option in status bar menu for quick re-authentication
  - "Verify Credentials" command to manually check if session is still valid
- New commands:
  - `LocalLeaf: Verify Credentials` - Check if your session is still valid
  - `LocalLeaf: Refresh Cookie` - Re-authenticate without full re-login (preserves server/email info)

### Fixed

- Fixed confusing "403" error messages when Overleaf cookie expires
- Session expiration now clearly indicates the need to re-login instead of showing generic sync errors
- Fixed folder delete not syncing to Overleaf (folders were not tracked in baseContent)
- Fixed folder rename creating a new folder instead of renaming (delete was ignored, then create made new folder)
- Folder paths are now properly handled with trailing slashes in delete operations
- Fixed folder structure not being created when pushing to Overleaf ([Issue #1](https://github.com/Teddy-van-Jerry/LocalLeaf/issues/1))
  - Files in subfolders (e.g., `tex/introduction.tex`) were incorrectly placed in root instead of their folder
  - Parent folders are now automatically created before uploading files
  - Folder entries are immediately tracked in the file tree after creation (no longer relies solely on socket events)

## [0.1.2] - 2025-12-21

### Fixed

- Fixed critical bug where new files created on Overleaf were incorrectly deleted when they didn't exist locally
- Files are now only deleted from Overleaf if they were previously synced locally (tracked in baseContent)

### Changed

- New files from Overleaf now require user acceptance before downloading (Download/Skip/Download All New/Skip All New)
- This applies to both manual pull and real-time sync when collaborators create files

### Added

- Detection of files deleted on Overleaf during pull (prompts user to delete locally, keep, or re-upload)
- Detection of local-only files during pull (prompts user to upload or ignore)
- Logging when files are deleted from Overleaf

## [0.1.1] - 2025-12-16

### Fixed

- Fixed "Failed to sync: EntryNotFound (FileSystemError)" race condition during rapid file operations (e.g., git checkout)
- Fixed file flashing in editor when receiving OT updates with no actual content changes
- Fixed real-time sync not receiving remote changes (documents now stay joined for OT updates)
- Fixed `.leafignore` patterns not working when main document differs from default (now auto-detects from Overleaf project)
- Fixed cursor tracking not updating for some cursor movements

### Added

- Resync option in status bar menu when sync errors occur
- Reconnect option in status bar menu when disconnected
- Real-time sync status in Output panel ("Pushed to Overleaf", "Remote update" messages)
- Auto-detection of main document from Overleaf project settings
- Project website is now live at https://localleaf.wqzhao.org

### Changed

- Simplified socket connection to use v2 scheme directly
- Reduced verbose console logging in production


## [0.1.0] - 2025-12-13

### Added

- Initial release
- Real-time two-way sync with Overleaf via Socket.IO
- Cookie-based authentication with tutorial link
- Cursor tracking for real-time collaboration
- Conflict resolution with visual diff view
- Support for "Use Local" (push to Overleaf) and "Use Remote" (pull from Overleaf)
- Ignore patterns support via `.leafignore`
- Status bar items for sync status and logged-in account
- Commands:
  - Login / Logout
  - Link Folder / Unlink Folder
  - Sync Now / Pull from Overleaf / Push to Overleaf
  - Show Sync Status
  - Edit Ignore Patterns
  - Set Main Document
  - Configure Settings
  - Jump to Collaborator
