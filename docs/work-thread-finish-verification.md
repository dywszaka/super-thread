# Work Thread Finish verification

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
