# SuperThread

SuperThread is a macOS desktop MVP for organizing work into WorkThreads, managing Git projects across local and SSH devices, creating isolated worktrees, and working in persistent terminal sessions.

## Run

```bash
npm install
npm run dev
```

Build and verify:

```bash
npm test
npm run build
```

## Architecture

- `src/main`: Electron native shell, persistence, device runtimes, Git and PTY ownership.
- `src/preload`: narrow, typed bridge; the renderer has no direct Node access.
- `src/renderer`: React workbench, semantic design tokens, project/work-thread navigation, workspace and terminal switchers.
- `src/shared`: domain model and validated IPC contract.

The implementation deliberately keeps the MVP domain to `WorkThread`, `Project`, `Device`, `Workspace`, and `Session`. A WorkThread groups one or more workspaces; a project is identified by its canonical Git remote; physical checkouts belong to devices; worktrees and terminals belong to workspaces.

On macOS, closing the window leaves the application runtime alive, so PTY sessions continue and can be reattached when the window is reopened. Quitting the application terminates the local runtime; recovery across a full runtime restart is intentionally a post-MVP concern.
