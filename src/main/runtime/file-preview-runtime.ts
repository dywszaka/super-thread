import { randomUUID } from "node:crypto";
import { app, BrowserWindow, WebContentsView, nativeTheme, session, type Session, type WebContents } from "electron";
import { channels } from "../../shared/contract";
import type { BrowserLayoutInput, FilePreviewState, FilePreviewTab, NavigateFilePreviewInput } from "../../shared/domain";
import { MAX_PREVIEW_FILE_BYTES, MAX_PREVIEW_TEXT_BYTES, previewFileType } from "../../shared/file-preview";
import type { WorkspaceService } from "../application/workspace-service";
import { attachWorkspaceShortcuts } from "../windows/workspace-shortcuts";
import { previewByteResponse, previewMimeType, renderPreviewMarkdown } from "./file-preview-content";

export const FILE_PREVIEW_SCHEME = "workspace-preview";
interface PreviewPage {
  tab: FilePreviewTab;
  view: WebContentsView;
  session: Session;
  token: string;
  controller: AbortController;
  pending: Map<string, Promise<Buffer>>;
  state: FilePreviewState;
  url: string;
  lastGesture: number;
  visible: boolean;
}

export class FilePreviewRuntime {
  private window: BrowserWindow | null = null;
  private pages = new Map<string, PreviewPage>();
  private layout: BrowserLayoutInput | null = null;
  private cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private reads = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly service: WorkspaceService) {
    // Chromium's PDF viewer owns a guest WebContents with a separate input stream.
    app.on("web-contents-created", (_event, contents) => {
      if (!this.window || contents.getType() !== "remote") return;
      const page = [...this.pages.values()].find((page) => page.tab.fileType === "pdf" && page.session === contents.session);
      if (!page) return;
      attachWorkspaceShortcuts(this.window, contents);
      this.trackGestures(page, contents);
    });
    service.on("changed", () => {
      const tabs = service.snapshot().filePreviewTabs;
      for (const [id, page] of [...this.pages]) {
        const tab = tabs.find((tab) => tab.id === id);
        if (!tab) this.destroy(id);
        else if (tab.path !== page.tab.path || tab.fileType !== page.tab.fileType) {
          this.destroy(id);
          // Recreate the sandbox when formats change, especially HTML → Markdown.
          if (this.layout?.id === id && this.window && !this.window.isDestroyed()) {
            this.create(tab);
            this.applyLayout();
          }
        }
      }
    });
    nativeTheme.on("updated", () => {
      for (const page of this.pages.values()) if (page.tab.fileType === "markdown") this.load(page);
    });
  }

  attach(window: BrowserWindow): void {
    this.window = window;
    this.layout = null;
    window.on("closed", () => {
      for (const id of [...this.pages.keys()]) this.destroy(id);
      this.window = null;
      this.layout = null;
    });
    window.on("resize", () => this.applyLayout());
    window.webContents.on("did-start-loading", () => this.hide());
    window.webContents.on("render-process-gone", () => this.hide());
  }

  private publish(page: PreviewPage): void {
    if (!this.window?.isDestroyed() && this.pages.get(page.tab.id) === page) this.window?.webContents.send(channels.filePreviewStateChanged, { ...page.state });
  }

  private create(tab: FilePreviewTab): PreviewPage {
    if (!this.window || this.window.isDestroyed()) throw new Error("Preview window is unavailable");
    const isolated = session.fromPartition(`file-preview-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.on("will-download", (event) => event.preventDefault());
    const view = new WebContentsView({ webPreferences: {
      session: isolated, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      sandbox: true, contextIsolation: true, webSecurity: true, webviewTag: false,
      javascript: tab.fileType !== "markdown", plugins: tab.fileType === "pdf", navigateOnDragDrop: false
    } });
    const page: PreviewPage = { tab, view, session: isolated, token: randomUUID(), controller: new AbortController(), pending: new Map(), state: { id: tab.id, loading: true }, url: "", lastGesture: 0, visible: false };
    this.pages.set(tab.id, page);
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    attachWorkspaceShortcuts(this.window, view.webContents);
    isolated.protocol.handle(FILE_PREVIEW_SCHEME, (request) => this.respond(page, request));
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(`${FILE_PREVIEW_SCHEME}://${page.token}/`)
        || (tab.fileType === "html" && details.url.startsWith(`blob:${FILE_PREVIEW_SCHEME}://${page.token}/`))
        || (tab.fileType === "pdf" && (details.url.startsWith("chrome-extension://") || details.url.startsWith("chrome://resources/")))
        || details.url.startsWith("data:");
      callback({ cancel: !allowed });
    });
    const contents = view.webContents;
    this.trackGestures(page, contents);
    contents.on("will-navigate", (event, url) => {
      event.preventDefault();
      if (Date.now() - page.lastGesture < 1500) void this.openLink(page, url);
    });
    contents.on("will-frame-navigate", (event) => { if (!event.isMainFrame && !event.url.startsWith("chrome-extension://")) event.preventDefault(); });
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (Date.now() - page.lastGesture < 1500) void this.openLink(page, url);
      return { action: "deny" };
    });
    contents.on("did-stop-loading", () => { page.state.loading = false; this.publish(page); });
    contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
      if (mainFrame && code !== -3 && url === page.url) { page.state.loading = false; page.state.error ??= description; this.publish(page); }
    });
    contents.on("render-process-gone", () => { page.state.loading = false; page.state.error = "Preview stopped responding. Refresh to retry."; this.publish(page); });
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    this.load(page);
    return page;
  }

  private trackGestures(page: PreviewPage, contents: WebContents): void {
    contents.on("input-event", (_event, input) => {
      if (["mouseDown", "mouseUp", "keyDown", "rawKeyDown", "keyUp"].includes(input.type)) page.lastGesture = Date.now();
    });
  }

  private async openLink(page: PreviewPage, url: string): Promise<void> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const tab = await this.service.createBrowser({ workspaceId: page.tab.workspaceId, url });
        this.window?.webContents.send(channels.browserCreated, tab);
      } else if (parsed.protocol === `${FILE_PREVIEW_SCHEME}:` && parsed.hostname === page.token) {
        const path = decodeURIComponent(parsed.pathname.slice(1));
        if (!previewFileType(path)) return;
        const tab = await this.service.openFilePreview({ workspaceId: page.tab.workspaceId, path });
        this.window?.webContents.send(channels.filePreviewCreated, tab);
      }
    } catch (cause) { page.state.error = String(cause); this.publish(page); }
  }

  private load(page: PreviewPage): void {
    page.url = `${FILE_PREVIEW_SCHEME}://${page.token}/${page.tab.path.split("/").map(encodeURIComponent).join("/")}`;
    page.state = { id: page.tab.id, loading: true };
    this.publish(page);
    void page.view.webContents.loadURL(page.url).catch(() => { /* The protocol and did-fail-load publish useful errors. */ });
  }

  private async read(page: PreviewPage, path: string, signal: AbortSignal): Promise<Buffer> {
    const key = `${page.token}:${path}`;
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const pending = page.pending.get(key);
    if (pending) return pending;
    const operation = (async () => {
      if (this.reads >= 4) await new Promise<void>((resolve) => this.waiters.push(resolve));
      else this.reads++;
      try {
        if (signal.aborted) throw new Error("File request cancelled");
        const type = previewFileType(path);
        const bytes = await this.service.workspaceFiles(page.tab.workspaceId).read(path, type === "html" || type === "markdown" ? MAX_PREVIEW_TEXT_BYTES : MAX_PREVIEW_FILE_BYTES, signal);
        if (signal.aborted) throw new Error("File request cancelled");
        this.cache.set(key, bytes);
        this.cacheBytes += bytes.length;
        while (this.cacheBytes > 256 * 1024 * 1024) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.length;
          this.cache.delete(oldest);
        }
        return bytes;
      } finally {
        const next = this.waiters.shift();
        if (next) next(); else this.reads--;
      }
    })();
    page.pending.set(key, operation);
    try { return await operation; } finally { page.pending.delete(key); }
  }

  private async respond(page: PreviewPage, request: Request): Promise<Response> {
    const controller = page.controller;
    const url = new URL(request.url);
    if (this.pages.get(page.tab.id) !== page || url.hostname !== page.token || controller.signal.aborted) return new Response(null, { status: 410 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    let path = "";
    try {
      path = decodeURIComponent(url.pathname.slice(1));
      let bytes = await this.read(page, path, controller.signal);
      if (controller.signal.aborted) return new Response(null, { status: 410 });
      let mime = previewMimeType(path);
      if (path === page.tab.path && page.tab.fileType === "markdown") {
        bytes = Buffer.from(renderPreviewMarkdown(bytes.toString("utf8"), nativeTheme.shouldUseDarkColors));
        mime = "text/html; charset=utf-8";
      }
      return previewByteResponse(bytes, mime, request.headers.get("range"), request.method, page.tab.fileType === "html" ? "html" : "static");
    } catch (cause) {
      if (!controller.signal.aborted) {
        page.state.error = `${path === page.tab.path ? "Could not preview file" : `Could not load resource ${path}`}: ${String(cause)}`;
        page.state.loading = false;
        this.publish(page);
      }
      return new Response(null, { status: 404 });
    }
  }

  async navigate(input: NavigateFilePreviewInput): Promise<FilePreviewTab> {
    const previous = this.service.snapshot().filePreviewTabs.find((tab) => tab.id === input.id);
    const selected = await this.service.navigateFilePreview(input);
    if (selected.id === input.id && previous?.path === selected.path) this.refresh(selected.id);
    return selected;
  }

  refresh(id: string): void {
    const tab = this.service.snapshot().filePreviewTabs.find((tab) => tab.id === id);
    if (!tab) throw new Error("File preview no longer exists");
    const page = this.pages.get(id);
    if (!page) return; // Restored tabs remain lazy until first selection.
    page.controller.abort();
    page.view.webContents.stop();
    this.clearCache(page);
    page.controller = new AbortController();
    page.token = randomUUID();
    this.load(page);
  }

  states(): FilePreviewState[] { return [...this.pages.values()].map((page) => ({ ...page.state })); }

  setLayout(layout: BrowserLayoutInput): void {
    if (layout.id && !this.pages.has(layout.id)) {
      const tab = this.service.snapshot().filePreviewTabs.find((tab) => tab.id === layout.id);
      if (!tab) throw new Error("File preview no longer exists");
      this.create(tab);
    }
    this.layout = layout;
    this.applyLayout();
  }

  private applyLayout(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const [width = 0, height = 0] = this.window.getContentSize();
    for (const [id, page] of this.pages) {
      const bounds = this.layout?.bounds;
      const visible = id === this.layout?.id && !!bounds && bounds.width > 0 && bounds.height > 0;
      if (visible && bounds) {
        const x = Math.min(width, Math.round(bounds.x)), y = Math.min(height, Math.round(bounds.y));
        page.view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height))) });
      }
      const returnFocus = !visible && page.view.webContents.isFocused();
      if (visible !== page.visible) { page.view.setVisible(visible); page.visible = visible; }
      if (returnFocus) this.window.webContents.focus();
    }
  }

  private clearCache(page: PreviewPage): void {
    for (const [key, bytes] of this.cache) if (key.startsWith(`${page.token}:`)) { this.cacheBytes -= bytes.length; this.cache.delete(key); }
  }
  private destroy(id: string): void {
    const page = this.pages.get(id);
    if (!page) return;
    this.pages.delete(id);
    page.controller.abort();
    this.clearCache(page);
    page.pending.clear();
    page.session.webRequest.onBeforeRequest(null);
    page.session.protocol.unhandle(FILE_PREVIEW_SCHEME);
    void page.session.clearCache().catch(() => { /* The session may already be tearing down. */ });
    if (!this.window?.isDestroyed()) this.window?.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false });
  }
  hide(): void { this.layout = null; this.applyLayout(); }
}
