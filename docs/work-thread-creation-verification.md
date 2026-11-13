# Work Thread creation verification

Verified on macOS, 2026-11-13.

## Automated checks

- `npm test`: 222 passing tests.
- `npm run build`: TypeScript and all Electron bundles pass.
- `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`: unpacked macOS app generated with native dependencies rebuilt.
- Standard `npm run pack` compiled successfully but signing failed with `errSecInternalComponent` in the local signing environment. The unsigned packaging check does not verify release signing.

Coordinator and service coverage includes required nonempty workspace configuration, strict ownership inputs, duplicate configuration IDs, thread/workspace conflicts, unavailable checkouts, ordinary directories, multiple devices, main-directory exclusivity, sequential progress, duplicate submissions, first/midway failure, corrected retries, immutable successful entries, document preservation, leftover cleanup, discard semantics, running-thread guards, early terminal exit, and PTY cleanup after a failed session save. Workbench tests cover retaining drafts through dialog close and navigation, avoiding template replacement, step changes, and excluding drafts/progress from persisted preferences.

## Real Electron checks

Ran the built main/preload/renderer with an isolated temporary app-data directory and temporary Git repositories. A test-only home-directory override kept new worktrees inside the temporary fixture; production data and repositories were not used.

- Light appearance at 1320×840 and dark appearance at 880×560; reviewed screenshots of definition, configuration, confirmation, retry, and success.
- Narrow configuration/confirmation dialogs keep their footer visible, scroll only the body, and retain `no-drag` on the modal.
- Closing/reopening retains both configured workspaces.
- Creation continues after closing the dialog. A nonexistent second base branch pauses creation after the first workspace and its PTY succeed.
- Correcting the branch retries the failed workspace only: one thread, two ready worktrees, two sessions, and the original saved Doc.
- Successful workspace inputs are disabled; completion opens the Doc with the thread expanded.
- Real PTY input/output, resize, attach, workspace switching, and terminal close.
- Closing/reopening the native window preserves and reattaches the original PTY.
- An ordinary-folder main workspace and default PTY initialize through the validated bridge.

Screenshots and the Electron result JSON are retained in the chat's local visualization directory under `work-thread-creation/`.

## Remaining verification limits

No real SSH host was supplied for this change. Multiple-device orchestration and remote failure handling have automated coverage; live SSH workspace/terminal creation still needs a configured test host. OS-level traffic-light hit testing and physical window dragging were not automated; their existing insets and drag regions were preserved.
