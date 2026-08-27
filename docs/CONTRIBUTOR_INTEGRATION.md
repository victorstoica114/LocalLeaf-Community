# Contributor integration audit

This document records the contributor work reviewed for LocalLeaf Community and
the disposition of each public upstream pull request. The audit was refreshed on
2026-08-27 against the GitHub API and the preserved Git history.

## Pull request inventory

| Upstream pull request | Contributor | Status in LocalLeaf Community |
|---|---|---|
| [#3 — Minor Improvement](https://github.com/Teddy-van-Jerry/LocalLeaf/pull/3) | Xingyu Chen (Asixa / RFDT) | All 34 commits reviewed. Safe portions are integrated or reimplemented; the remaining feature groups are explicitly deferred below. The original head is preserved at `archive/asixa-pr-3`. |
| [#5 — Fix file creation and binary sync races](https://github.com/Teddy-van-Jerry/LocalLeaf/pull/5) | Victor Stoica | Fully integrated, then extended with additional race, rollback, dirty-editor, and remote-event protections. |
| [#6 — Add secure LocalLeaf GUI integration](https://github.com/Teddy-van-Jerry/LocalLeaf/pull/6) | Victor Stoica, incorporating and crediting Asixa's UI work | Fully represented in the Community branch and subsequently hardened. The upstream PR remains open because it targets the original repository. |

The Community repository itself had no public pull requests at the time of this
audit. PR commit IDs are not necessarily ancestors of `main`, because the
Community history represents the accepted work through equivalent authored
commits while the original SHA series is preserved separately; the table
describes functional integration, not just SHA ancestry.

## PR #3 commit-by-commit review

`Integrated / hardened` means the behavior is present, often as a safer rewrite.
`Partial / reworked` means only the useful portion is present. `Deferred` means
the original implementation is intentionally not in the production extension.

| Commit | Original topic | Disposition |
|---|---|---|
| `9d0b6a1` | Sidebar views | Integrated / hardened |
| `74b90d3` | Remove LaTeX comments | Integrated / hardened |
| `2f87c4c` | Local compiler and PDF viewer | Deferred |
| `a41fb83` | SyncTeX and compile-on-save | Deferred |
| `01f9020` | Manual-mode conflicts and tools sidebar | Partial / reworked |
| `bc0eb87` | PDF compiling indicator | Deferred |
| `25e29df` | PDF-to-source navigation | Deferred |
| `e8af676` | Account panel | Integrated / hardened |
| `7e3e591` | Cookie-login handling | Integrated / hardened |
| `2f46c2b` | Browser preferences and manual echo suppression | Partial / reworked |
| `94294c5` | Changes webview | Partial / reworked |
| `9f9126f` | Remote content and diff handling | Integrated / hardened |
| `4c82111` | Online collaborator display | Integrated / hardened |
| `0ae4c2f` | Document and path tracking | Integrated / hardened |
| `6abcbbf` | Remote echo and active-editor handling | Integrated / hardened |
| `c18b579` | Document and real-time event handling | Integrated / hardened |
| `a7b846a` | Dirty-document recovery and Undo | Integrated / hardened |
| `f5e1aba` | Base64 PDF loading | Deferred |
| `6dc013b` | Publisher, version, and package permissions | Partial / reworked for the Community package |
| `b5adb81` | PDF toolbar and recompile action | Deferred |
| `6327257` | SyncTeX highlighting | Deferred |
| `266a740` | PDF annotation links and webview messages | Deferred |
| `4cfa1a0` | PDF text selection and CSP changes | Deferred with the PDF viewer |
| `dc39781` | Source Control auto-push and Git hook | Deferred |
| `c67da61` | Watcher-echo suppression | Integrated / hardened |
| `e6586fb` | Activation and workspace detection | Integrated / hardened |
| `7b9dc2c` | Sidebar notifications and sync actions | Integrated / reworked |
| `59d62bb` | Change diffs and status behavior | Partial / reworked |
| `3e569b0` | Main sidebar webview | Integrated / reworked |
| `69a7a5e` | Manual recovery and zoom anchoring | Partial / reworked |
| `69dc212` | Hide Changes in real-time mode | Integrated |
| `018d262` | Tabbed sidebar layout | Integrated / reworked |
| `34af07f` | Ignore-file change pruning | Partial / reworked |
| `1520b9d` | Manual-sync recovery flows | Deferred |

## Security-driven rewrites

The integrated synchronization work now validates remote IDs, entity names,
paths, document operations, collaborator data, and webview messages before use.
It bounds network responses, Socket.IO event queues, OT payloads, project-tree
size and depth, and local project scans. Workspace containment and symbolic-link
checks protect every synchronization path. Dirty editor buffers are reconciled
through VS Code edits with version checks instead of being overwritten through
raw filesystem calls, and structural remote operations preserve unsaved files.

The comment-removal command was reimplemented conservatively. It performs a dry
run, limits the amount of input, requires confirmation, changes only standalone
comments and complete comment environments, and applies one undoable workspace
edit. It does not use the original broad text-replacement behavior.

## Deferred feature groups

### Manual change tracker and Source Control auto-push

The original manual-mode series stores a second baseline tree under
`.localleaf`, performs direct recursive filesystem operations, and adds a Git
commit hook that can trigger network writes. As proposed, it lacks the same path,
payload, dirty-editor, operation-ordering, and explicit-authorization guarantees
as the hardened real-time engine. Importing only fragments would also expose a
Changes UI whose state could not be trusted after restarts or concurrent edits.

This group should be redesigned as a separate feature: persistent state needs a
versioned and bounded schema, every path must use the shared safety layer, writes
must remain undoable where possible, and Git-triggered remote mutation must be
opt-in per workspace and per project. Until then, the production UI does not
claim that manual change tracking is available.

### Local compiler, PDF viewer, and SyncTeX

The original implementation launches workspace-controlled toolchains through a
shell and introduces a second PDF/SyncTeX stack alongside the established LaTeX
Workshop extension. Its PDF webview and external-link surface would require a
separate threat model, process allowlist, workspace-trust boundary, output-size
limits, and extensive platform testing.

LocalLeaf Community therefore delegates compilation, PDF viewing, and SyncTeX
to LaTeX Workshop or another dedicated extension. This avoids duplicating a
large security-sensitive subsystem while keeping LocalLeaf focused on Overleaf
synchronization.

## Attribution and history

The original PR #3 head (`1520b9d`) remains available in
`archive/asixa-pr-3`. Its 24 commits authored as RFDT and 10 commits authored as
Xingyu Chen remain intact. `.mailmap`, equivalent authored commits on `main`,
README, and [ATTRIBUTION.md](../ATTRIBUTION.md) make that work visible without
presenting deferred code as shipped functionality.
