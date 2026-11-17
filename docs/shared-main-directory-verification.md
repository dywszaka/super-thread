# Shared main project directory verification

Verified on macOS, 2026-11-17.

- Automated coverage checks cross-thread main-directory reuse for Git and ordinary folders, per-thread and standalone uniqueness, device-wide name conflicts, archived owners, warning scope, retry preservation, independent sessions, and Finish cleanup that preserves other users.
- Ran the built Electron app with temporary app data and a temporary Git repository. The new-thread wizard and an existing thread's New Workspace dialog both display the sharing reminder and successfully initialize separate real PTYs in the same checkout.
- Checked light/dark appearance at 1320×840 and 880×560. The reminder wraps within the dialog; narrow dialogs retain body scrolling and visible footer actions. Modal controls remain no-drag, with the existing titlebar/traffic-light region unchanged.
- Verified real PTY input/output, resize and attach. Deleting another workspace sharing the directory preserves both the checkout and the remaining terminal.

Screenshots and the result JSON are stored in this chat's visualization directory under `shared-main-directory/`. Live SSH creation and OS-level physical window dragging were not exercised; device scoping is covered by automated checks.
