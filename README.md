# SuperThread

SuperThread is a macOS desktop MVP for organizing work into WorkThreads, managing project folders with optional Git across local and SSH devices, using a project's main checkout or creating isolated worktrees, and working in persistent terminal sessions and workspace browser tabs. Each WorkThread opens with an autosaved Markdown document in a single WYSIWYG pane that formats Markdown as you type. Each WorkThread also has dated TODOs next to its Document: incomplete items and the last seven days of completions appear in the thread, while All todos retains the complete history across active and archived threads. Remote devices can also own local and reverse SSH port-forwarding rules with automatic reconnect after network loss or system wake while a window is open.

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

**Work Threads search:** Search active and archived threads by name or saved document text. All, Active, and Archived keep the same query, project, and time filters and show matching counts. All combines both statuses in document-update order and labels every thread Active or Archived. Project matches any of a thread's workspaces, including archived workspaces; successful workspace deletion and Finish retain project associations for later filtering. Previously deleted workspaces without retained associations cannot be reconstructed. The compact toolbar keeps search, status, project, and time controls on one row when space permits, and keeps project/time together in narrow layouts. Time uses a 0–12 dropdown followed by clickable 周 / 月 units: 0 disables the time filter and grays the whole time control; 1–12 limits results to recent weeks or calendar months, using saved document time or creation time for untouched documents. Results highlight matching names and show highlighted document excerpts; click anywhere on a result to open its document. The document opens in a layer over the unchanged list, two-thirds of the Work Threads content width. The underlying page uses a normal arrow cursor and keeps its overlay color while pressed. Clicking the underlying page, the close button, or Escape dismisses it and preserves search, filters, scroll, and focus. List rows omit Terminal and Doc buttons; More contains Finish, Archive, and Delete. The document drawer slides in from the right and slides out on close, with immediate switching when reduced motion is enabled. Finish checks every workspace for uncommitted changes, untracked files, and unmerged commits, asks for explicit force approval per risky worktree, deletes all workspaces, and archives the thread only when cleanup succeeds. Project directories, the thread Doc, and TODOs are kept. A failure leaves the thread active and retries operate on the remaining workspaces. Archive continues to hide the group while keeping its workspaces and sessions. Search is local, case-insensitive, and treats punctuation literally. Unsaved drafts and TODOs are not included.

**Work Thread definitions and reminders:** New Work Thread is a three-step wizard: define the thread, configure one or more workspaces from prepared Project × Device checkouts, then confirm and create. The editable Markdown definition starts with Goal, Scope, and Completion Criteria sections and becomes its autosaved, searchable Doc. Creation completes only after every workspace and its default terminal initialize. A failed item pauses the batch; successful workspaces remain, and correcting the remaining items retries without duplicates. Closing the dialog keeps the draft and lets running creation continue; New Work Thread reopens it during the same app runtime. Discard remaining keeps created entities. Quitting the app retains created entities but does not restore wizard configuration. Open Settings from the sidebar or `Cmd+,` to edit the template and reminder thresholds. Active threads show their age in the sidebar, list, and Doc, with a gentle reminder after 3 days and a stronger reminder after 7 days by default. Age runs from the original creation time, including archived time; archived threads show no reminders. Settings changes apply to future creation dialogs and immediately update reminder levels without changing existing documents.

**Projects:** Add any existing directory on a local or SSH device; Git and an origin remote are optional. Every project has a required, globally unique project code (case-insensitive) as well as a display name. The resolved path on the same device must also be unique; different paths can share a display name or Git remote when their codes differ. Symlink aliases resolve to the same directory. Ordinary folders use a direct-directory workspace; Git roots also support isolated worktrees. New worktrees use `~/.superthread/workspaces/<project code>/<workspace name>`. Existing projects gain a code from the Git remote repository name without `.git`, falling back to the project name when there is no remote; duplicates gain numeric suffixes. Codes can be edited in All projects. Existing workspace records and directories keep their paths, including after a code change.

**Work / Life:** The Work Threads sidebar has a Work / Life switch. It filters active sidebar threads, All work threads, and All todos with matching counts; projects, devices, and the workspace overview stay global. The selection is remembered locally and defaults to Work. Missing, null, or empty thread types read as Work without migrating or backfilling existing records. New threads default to the selected type and expose a Type field; sidebar and list menus can move existing or archived threads between types while preserving their documents, TODOs, workspaces, and terminals. Switching types opens the thread list (or keeps All todos open), dismisses thread details, and resets list filters. Creation drafts keep their type across closing and retries.

## Architecture

- `src/main`: Electron native shell, persistence, device runtimes, Git and PTY ownership.
- `src/preload`: narrow, typed bridge; the renderer has no direct Node access.
- `src/renderer`: React workbench, semantic design tokens, project/work-thread navigation, workspace and terminal switchers.
- `src/shared`: domain model and validated IPC contract.

The implementation deliberately keeps the MVP domain to `WorkThread`, `Project`, `Device`, `Workspace`, `Session`, `BrowserTab`, and `FilePreviewTab`. A Workspace can stand alone or belong to a WorkThread; projects are imported by device and resolved directory, with optional Git metadata; physical directories belong to devices; worktrees, terminals, and file previews belong to workspaces.

Embedded terminals support ordinary shells only; workspace tmux opens exclusively in iTerm. Remote terminals keep one interactive SSH connection and never create periodic SSH sessions for activity checks. The overview distinguishes local activity from remote connection counts.

On macOS, closing the window leaves the application runtime alive, so PTY sessions and established SSH tunnels continue and terminals can be reattached when the window is reopened. Tunnel retry timers and wake reconnects are suspended until a window is reopened. Quitting the application terminates the local runtime; recovery across a full runtime restart is intentionally a post-MVP concern.

The sidebar has independently collapsible **Work Threads** and **Workspaces** sections. The Workspaces section lists standalone workspaces and its add button creates one without a work thread. **All workspaces** also includes workspaces in active work threads.

Sidebar workspace rows show the workspace name above **device · project**, with local/remote icons and full context on hover. Device and project names truncate independently in narrow sidebars so workspaces from the same project on different devices remain distinguishable.

Workspace chrome stays compact: a 40px single-line header shows the workspace, device, and branch, with full context in its details dropdown. Focus remains an icon button; the actions menu contains VS Code, tmux in iTerm, New Workspace, Rename, and Delete. Tabs are 32px high, and Browser/File Preview toolbars are 32px high with 28px controls; narrow windows truncate names and scroll tabs without wrapping the header.

WorkThread workspaces also show their shared Doc / Todos in a right drawer, initially expanded at one third of the content width. The drawer fills the same height as Terminal, including its tabs, below the workspace header. Use the tab bar’s Doc toggle or the drawer close button to collapse it. Drag the divider to resize, use arrow keys when focused, or double-click / press Enter to restore one third. Width and visibility are remembered locally; narrow windows preserve usable minimum widths for both panes. Focus mode keeps the same Doc controls. Standalone workspaces have no Doc drawer.

Workspace tabs can contain multiple Terminals and Browsers in a shared, sortable tab bar. Browser tabs are local macOS web views owned by their Workspace, separate from PTY Sessions. Each saves its last HTTP(S) address and page title. Closing the main window destroys the web views; reopening the window or restarting the application restores every unclosed browser tab and automatically reloads its saved address, without restoring navigation history. Closing a browser tab removes its record; deleting a Workspace removes all its browser records.

`Cmd+W` closes the current workspace tab (Terminal, Browser, or File Preview). `Cmd+R` reloads the current Browser or refreshes the current File Preview. Both work when native page content has focus and pause while an app dialog is open. Use `Cmd+Shift+W` to close the window and `Cmd+Shift+R` to reload the app.

Bare domains default to HTTPS; localhost and loopback addresses default to HTTP. In remote Workspaces, localhost still refers to this Mac; remote web servers can be reached through the existing SSH port forwards. Pages run in sandboxed WebContentsViews without Node integration or app preload, and permissions and downloads are denied.

The workspace tab menu also offers **File Preview**. Browse workspace directories and select a PDF, HTML, or Markdown file to open it. Remote previews use the device's existing SSH configuration and require Python 3, with no remote service or port forwarding. Preview tabs share terminal/browser ordering and shortcuts, restore after restart, and load lazily when selected. The compact toolbar shows a read-only workspace-relative path, a refresh button, a download button, and a folder button. The folder button opens a file picker at the current file’s directory; select a file to replace the current preview or focus an already open preview. Paths cannot be typed in either the toolbar or the picker. Cancelling keeps the current file. Refresh explicitly rereads the file and its resources; switching tabs keeps the current content. Download saves the current original file to this Mac through a native save dialog, using the existing SSH configuration for remote files. Local previews can also be saved as a copy. Downloads reread the source and use the same size and workspace boundaries as preview; HTML resources are not bundled. Cancellation or failure preserves an existing destination file.

HTML can run embedded JavaScript and workspace-local scripts to render charts and reports from embedded data; fetch/XHR/WebSocket connections remain blocked. Markdown is read-only with scripts and raw HTML disabled. Scripts, images, styles, and fonts resolve within the workspace, including safe in-workspace symlinks; external resources and links escaping the workspace are blocked. Clicked HTTP(S) links open ordinary Browser tabs. HTML/Markdown files are limited to 5 MiB; PDFs and individual resources to 50 MiB. File bytes remain in a bounded runtime cache and are released when previews or the window close.
