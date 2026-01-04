# Changelog

All notable changes to LocalLeaf will be documented in this file.

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
