# SuperThread

SuperThread is a macOS desktop MVP for organizing work into WorkThreads, managing Git projects across local and SSH devices, using a project's main checkout or creating isolated worktrees, and working in persistent terminal sessions and workspace browser tabs. Each WorkThread opens with an autosaved Markdown document with editing and preview modes. Remote devices can also own local and reverse SSH port-forwarding rules with automatic reconnect after network loss or system wake.

## Run

```bash
npm install
npm run dev
```

The project-level `.npmrc` routes Electron runtime downloads through the
npmmirror binary mirror. Regular npm packages still use the user's configured
npm registry.

Build and verify:

```bash
npm test
npm run build
```

Build macOS release artifacts (`.dmg` and `.zip`) in `dist/`:

```bash
npm run release
```

Development and packaged builds share persistent data at
`~/Library/Application Support/super-thread/`. The domain snapshot is stored in
`workspace-runtime.json` inside that directory.

## Architecture

- `src/main`: Electron native shell, persistence, device runtimes, Git and PTY ownership.
- `src/preload`: narrow, typed bridge; the renderer has no direct Node access.
- `src/renderer`: React workbench, semantic design tokens, project/work-thread navigation, workspace and terminal switchers.
- `src/shared`: domain model and validated IPC contract.

The implementation deliberately keeps the MVP domain to `WorkThread`, `Project`, `Device`, `Workspace`, `Session`, and `BrowserTab`. A WorkThread groups one or more workspaces; a project is identified by its canonical Git remote; physical checkouts belong to devices; worktrees and terminals belong to workspaces.

On macOS, closing the window leaves the application runtime alive, so PTY sessions continue and can be reattached when the window is reopened. Quitting the application terminates the local runtime; recovery across a full runtime restart is intentionally a post-MVP concern.

Workspace tabs can contain multiple Terminals and Browsers in a shared, sortable tab bar. Browser tabs are local macOS web views owned by their Workspace, separate from PTY Sessions. Each saves its last HTTP(S) address and page title. Closing the main window destroys the web views; reopening the window or restarting the application restores every unclosed browser tab and automatically reloads its saved address, without restoring navigation history. Closing a browser tab removes its record; deleting a Workspace removes all its browser records.

Bare domains default to HTTPS; localhost and loopback addresses default to HTTP. In remote Workspaces, localhost still refers to this Mac; remote web servers can be reached through the existing SSH port forwards. Pages run in sandboxed WebContentsViews without Node integration or app preload, and permissions and downloads are denied.
