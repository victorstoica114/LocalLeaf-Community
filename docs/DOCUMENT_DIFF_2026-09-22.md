# Large document revision recovery — 0.2.16

The reported synchronization failure was `Document diff exceeded its budget; local changes are preserved`. The local logs confirmed this exact error. It came from the diff between two revisions of one document: both the character and line algorithms could exhaust their 50 ms / 8,192-edit allowances. Repeating synchronization retried the same failing calculation.

The failure is reproducible using 17,000 rewritten lines in a document of approximately 227 KB. It does not require many files or a document near the server's size limit.

## Change

Document OT generation now trims common UTF-16 boundaries, uses a deterministic amount of fine-diff work, and partitions difficult revisions around ordered unchanged line anchors. Unresolved gaps become exact delete/insert operations against the authoritative document version. A complex revision therefore produces a valid update instead of a diff-budget synchronization error.

Unique line anchors are selected in order on both sides, with adjacent matches combined. Fine-diff work and anchor depth are bounded without using elapsed time to choose the result. The same before/after content therefore produces the same operations when recovering an interrupted journaled upload. Replacement boundaries preserve valid Unicode surrogate pairs.

Highly fragmented results retain the largest unchanged gaps and combine smaller intervening gaps to fit LocalLeaf's existing 10,000-component transport validation limit. This can make edits coarser inside the combined spans. It preserves exact requested content against the source revision, but cannot promise to preserve every independent concurrent edit inside a coarsened span. The existing authoritative versions, server OT transformation, durable journal and reread after application remain in use. Automatic three-way merge and server document-size limits are unchanged.

The release audit found that skipping fine diff above a fixed character threshold could unnecessarily replace a long single line even when only its two ends changed. Such a replacement could reintroduce a concurrent deletion in the otherwise unchanged middle. The fixed character cutoff was removed: large regions can use fine diff when their edit distance fits the same deterministic work allowance. The regression now checks concurrent insertions and deletions in that retained middle.

## Validation

- The complete `npm test` suite passed again after the release-audit correction, including compilation, lint and the existing real HTTP/WebSocket two-client synchronization tests.
- `documentDiffBudgetTest.ts` validates large line/character changes, repeated lines, insertion/deletion, retained boundaries and anchors, concurrent edits in retained anchors, Unicode, the operation format and journaled engine uploads. Additional cases recover after interruption before and after server commit, with identical operations, the original version and duplicate-source identifiers, and exactly one committed upload.
- An independent seeded check applied 3,592 generated cases with the vendored upstream Overleaf OT implementation, including reordered anchors and heavily fragmented revisions. Exact resulting content, Unicode boundaries, repeatability and operation counts passed.
- The release audit added regressions for concurrent insertions/deletions between two small edits in a 40,000-character line and for 6,001 real edit regions separated by unique anchors. The latter compacts to exactly 10,000 components while retaining large anchors and deterministic output.
- An additional independent check of 24,336 small Unicode pairs passed. Larger fine-diff regions use more temporary memory than the initial candidate: generated cases near two million UTF-16 characters took approximately 150-210 ms including simple application, with consecutive calls reaching roughly 211 MiB of process heap before garbage collection. The work allowance remains bounded; sufficiently large or complex gaps still use coarser replacements.

The regression tests use generated content and local fixtures; the user's manuscript is not modified by the tests.

The final release VSIX contains 14 files (259,829 bytes). Package contents, exclusions, versions, license notices and the dated changelog were verified; both runtime bundles match the production build. VSIX SHA-256: `bb1e1f006ae0d7601f418570708384907c0ffb22d28c5bfc0f1a342c3a96e34c`.
