# Work Thread Finish verification

## Repository commit collection — 2026-11-24

- `npm test`: 312 passing tests. `npm run build`: TypeScript and all Electron bundles pass.
- Runtime tests cover fixed creation ranges after ordinary/squash merges, more than 20 commits without truncation, Unicode subjects, main-directory and empty repositories, detached HEAD, inferred/unknown starting points, rewritten history, missing objects, failed history reads, and SSH command quoting. Existing deletion-risk checks remain covered.
- Service tests verify both Completed and Cancelled, local/remote/main histories, saving evidence before Git deletion, partial failure and retry without losing successful records, concurrent Doc saves, restore and JSON reload. Markdown tests cover full hashes, escaped subjects, warnings, empty ranges and old summaries without collected history.
- Real Electron verification used `/tmp/superthread-commits-electron-qa-7` with isolated app data and real repositories. Finish preview showed two worktree commits and three main-directory commits, including already merged work. Go back retained the worktree, live terminal and snapshot without a saved summary. Successful Finish stopped the real PTY, removed the worktree and branch, retained the project directory and Doc, and saved both histories. Restore and a separate process restart retained the records.
- Copy Markdown, export through the existing native-save IPC (the QA harness selected a temporary output path), and Add summary to Doc retained commit text while escaping HTML-like subjects. Repository text rendered literally. Keyboard Space toggled the native disclosure. Light 1320×840 and dark 880×560 screenshots were visually inspected, including long unbroken commit titles and the 426px document drawer; no horizontal overflow, footer controls remained visible, and computed drag/no-drag regions were preserved.
- Screenshots, profile, result JSON and exported Markdown remain in the temporary QA directory; the harness is `/tmp/superthread-commits-qa.mjs`. Physical traffic-light hit testing/window dragging and a live SSH host were not tested. SSH dispatch and failures are covered by runner/service fixtures. This change does not modify IPC channels, preload loading, Electron packaging or PTY integration, so no packaging run was required.

Verified on macOS, 2026-11-13.

- `npm test`: 236 passing tests.
- `npm run build`: TypeScript and all Electron bundles pass.
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`: unpacked macOS app generated. Signing remains unverified because of the local signing issue recorded in the creation-wizard verification.

Service tests cover read-only inspection, local/remote Workspace ownership, uncommitted changes, untracked files, unmerged commits, explicit per-workspace force approval, failed checks that cannot be bypassed, changed confirmation lists, partial deletion failure and retry, archival-write failure and retry, concurrent mutation guards, already-running deletion, creation guards, empty threads, legacy metadata cleanup, main/base-directory retention, unrelated-workspace isolation, terminal/tab cleanup, live PTY cleanup despite stale session metadata, and Doc/TODO preservation.

Real Electron verification used temporary app data, repositories, and worktrees; production data was not used. The built main/preload/renderer passed these checks:

- Finish opens from the list More menu, sidebar context menu, and active Doc header.
- Real Git checks identify all three risk categories for a worktree with an unmerged commit, dirty tracked file, and untracked file.
- Force approval starts unchecked and the submit button is disabled until approval. Refresh clears approval. Cancel leaves all workspaces and directories intact.
- Light 1320×840 and dark 880×560 screenshots show readable consequences and risks, scrolling dialog content, visible fixed footer controls, and `no-drag` on the modal.
- Submission deletes both the approved dirty worktree and a clean worktree, removes their branches, terminates their PTYs, and removes a main Workspace while retaining the project directories.
- The thread is archived only after cleanup, retains its Doc, and can be restored without recreating the deleted workspaces.

Screenshots and the result JSON are retained in the chat's visualization directory under `work-thread-finish/`. Live SSH deletion was not tested against a real host; remote dispatch and check failures are covered with service-runtime fixtures. Physical traffic-light hit testing and dragging were not automated; existing insets and drag regions were preserved.

## Completion outcome and note — 2026-11-19

- `npm test`: 286 passing tests; `npm run build`: TypeScript and all Electron bundles pass.
- Finish defaults to Completed with an empty optional note. Completed / Cancelled are validated through the existing typed IPC, with a 5,000-character note limit. Outcome, note, and finish time save atomically with archival only after cleanup succeeds.
- Service tests cover both outcomes, multiline/whitespace retention, legacy defaults, invalid input, reload/restore, replacing the last result on a later Finish, plain Archive without inferred completion, and deletion/archival failures without a new result.
- A real Electron run with isolated `/tmp/superthread-finish-outcome-qa` data verified native radio keyboard selection, note labeling and limit, refresh retaining inputs, Go back preserving the snapshot and directory, Escape dismissal, reopen defaults, and both successful outcomes through the main/preload/renderer bridge.
- Cancelled Finish removed a real main-directory Workspace while retaining the directory and Doc. Archived Doc details displayed the saved note as literal text, including HTML-like text, and restoring the thread retained the result as Last finish. An empty thread finished with Completed and an empty note.
- Light 1320×840 and dark 880×560 screenshots were visually inspected: radio choices and multiline input remain readable, footer stays visible, body scrolls, and the narrow document drawer shows the expandable result without overflow. Existing header drag and modal no-drag regions were checked through computed styles. Physical traffic-light hit testing and window dragging were not automated; native shell configuration is unchanged.
- A separate Electron process restart verified both persisted outcomes and the multiline note. Screenshots, verification harness, and result JSON are in `/tmp/superthread-finish-outcome-qa`.
