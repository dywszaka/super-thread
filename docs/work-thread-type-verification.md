# Work / Life verification

Verified on macOS on 2026-11-17 with a built Electron app and an isolated snapshot under `/tmp`; existing application data was not used.

## Automated coverage

- Missing, empty-string and null types resolve to Work without mutating threads or rewriting a current-version snapshot on load.
- Create, batch-create and change-type IPC schemas accept only `work` and `life`; legacy callers can omit the type.
- Type changes survive concurrent document autosave, archive/restore, rename and snapshot reload. Document content and timestamps remain independent of the type change.
- A failed batch creation retains Life on retry, even if a later submission tries to change it.
- Cross-type reordering is rejected. Switching type clears document/workspace navigation while preserving terminal selections, creation drafts and expansion state; All todos stays open.
- `npm test`, `npm run build`, and `git diff --check` passed.

## Electron checks

- Light appearance at 1320×840 and 880×560; dark appearance at 880×560. Representative screenshots were captured in the verification chat.
- A 184px sidebar displays both Work / Life buttons fully, with native traffic lights and the sidebar collapse control clear. Narrow content wraps filters without horizontal overflow.
- Work initially contains legacy and empty-type threads; Life shows its active threads. All / Active / Archived counts include only the selected type. All todos includes only that type's active and archived TODOs.
- Tab then Space changes Work to Life; accessibility exposes each button's pressed state. Both buttons are clickable within the no-drag region.
- Creating from Life defaults the wizard Type to Life; confirmation shows Life. Creating a project-directory workspace completes through real IPC, persists the type and opens the new thread and its default terminal.
- More → Move to Life removes a legacy thread from Work and updates thread/TODO counts; switching to Life reveals it there.
- Switching Work / Life while a workspace terminal exists keeps the same terminal tab and its output available when returning.
- Restarting the isolated app restores Life and the 184px sidebar width. With the sidebar hidden, the page heading still identifies Life and clears the traffic-light inset.

No Electron configuration, preload-loading or native-dependency changes are included; no packaging change was needed.
