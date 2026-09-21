# AGENTS.md

This file is the concise navigation guide for coding agents working in SuperThread.

## Start here

1. Read `README.md` for the current product summary, run commands, and top-level module map.
2. Read `docs/mvp.md` for the product scope, domain model, runtime API, and acceptance criteria.
3. Read `docs/mac-native-ui-framework.md` for the native shell, renderer architecture, design system, and macOS interaction requirements.

## Source-of-truth locations

- Product requirements and domain constraints: `docs/mvp.md`
- Desktop UI architecture and native behavior: `docs/mac-native-ui-framework.md`
- Current implementation overview: `README.md`
- Shared domain types and bridge contract: `src/shared/`
- Native shell, persistence, Git, SSH, and PTY ownership: `src/main/`
- Renderer workbench and design tokens: `src/renderer/`
- Automated tests: `tests/`
- Build and command definitions: `package.json`, `electron.vite.config.ts`, `tsconfig.json`

## Architecture and ownership

- Keep the MVP domain limited to `Project`, `Device`, `Workspace`, and `Session`; do not introduce Task, Agent, Workflow, Review, or SaaS concepts without an approved scope change.
- Preserve the model boundary: Project is a logical Git repository, Device owns execution, Workspace owns the isolated worktree/runtime context, and Session owns a terminal process.
- Filesystem, Git, SSH, and PTY operations belong in `src/main`; renderer code must use the narrow typed bridge in `src/preload` and must not access Node directly.
- Put cross-process types, validated channel names, and inputs in `src/shared`; validate untrusted IPC input before invoking services.
- Keep UI features dependent on the workbench/design layer, never the reverse. Use semantic CSS tokens and preserve traffic-light insets, drag regions, and explicit `no-drag` controls.

## Working rules

- Prefer small, verifiable changes and preserve unrelated worktree changes.
- Treat `docs/mvp.md` as the scope boundary and update it when product behavior changes.
- Keep persistent domain data separate from runtime state; do not trust a stored PID or running status without runtime reconciliation.
- Do not commit credentials, SSH material, Electron user-data contents, generated caches, `out/`, `dist/`, or `node_modules/`.
- Keep comments focused on non-obvious boundaries or platform behavior.

## Development workflow

- Identify the smallest coherent change set and inspect the affected main/preload/renderer boundary before editing.
- Implement tests or proportionate manual verification for the affected behavior.
- Run the relevant commands below before reporting completion.
- After code changes are implemented and tests or verification pass, create a self-contained git commit for that change set before reporting completion or moving on.
- Do not include unrelated staged or unstaged user changes in an agent-created commit.

## Commands

- Install dependencies and rebuild native Electron modules: `npm install`
- Run the desktop app in development: `npm run dev`
- Typecheck: `npm run lint`
- Run unit tests: `npm test`
- Typecheck and build all Electron bundles: `npm run build`
- Build an unpacked macOS app: `npm run pack`
- Preview the production bundle: `npm run preview`

## Testing and acceptance

- For shared, persistence, Git, or runtime changes, run `npm test` and `npm run build` at minimum.
- For IPC or native dependency changes, verify the packaged or development Electron app, not only the renderer bundle.
- For UI changes, manually check light/dark appearance, traffic-light clearance, drag/no-drag behavior, constrained-window layout, and the affected dialog or workspace flow.
- For terminal changes, verify create, attach, input/output, resize, switch, and close behavior in a real workspace; PTYs must survive renderer/window disconnect while the app runtime remains alive.
- Run `npm run pack` when changing Electron configuration, preload loading, packaging, or `node-pty` integration.

## Existing research and design material

- `docs/mac-native-ui-framework.md` documents the reusable Electron/macOS workbench framework and the native SwiftUI/AppKit alternative.
- `docs/mvp.md` documents the intended `Project × Device → Workspace → Persistent Terminal` product chain and explicit non-goals.
