import { attachWorkspaceShortcuts } from "../windows/workspace-shortcuts";
import { BrowserWindow, WebContentsView, session } from "electron";
import type { BrowserLayoutInput, BrowserState, BrowserTab } from "../../shared/domain";
import { isBrowserUrl } from "../../shared/browser-url";
import { channels } from "../../shared/contract";
import type { WorkspaceService } from "../application/workspace-service";

interface Page {
  view: WebContentsView;
  visible: boolean;
  state: BrowserState;
  savingAddress: boolean;
  navigationGeneration: number;
}

/** Views belong to the window; durable addresses belong to WorkspaceService. */
export class BrowserRuntime {
  private window: BrowserWindow | null = null;
  private pages = new Map<string, Page>();
  private layout: BrowserLayoutInput | null = null;

  constructor(private readonly service: WorkspaceService) {
    const isolated = session.fromPartition("persist:workspace-browser");
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.on("will-download", (event) => event.preventDefault());
    service.on("changed", () => this.reconcile());
  }

  attach(window: BrowserWindow): void {
    this.window = window;
    this.layout = null;
    window.on("closed", () => {
      for (const id of [...this.pages.keys()]) this.destroy(id);
      this.window = null;
      this.layout = null;
    });
    // Keep the native surface attached during live resize; hiding it between
    // renderer measurements exposes the empty host on every resize event.
    window.on("resize", () => this.applyLayout());
    window.webContents.on("did-start-loading", () => this.hide());
    window.webContents.on("render-process-gone", () => this.hide());
    this.reconcile();
  }

  private reconcile(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const tabs = this.service.snapshot().browserTabs;
    for (const id of [...this.pages.keys()]) if (!tabs.some((tab) => tab.id === id)) this.destroy(id);
    for (const tab of tabs) if (!this.pages.has(tab.id)) this.create(tab);
  }

  private create(tab: BrowserTab): void {
    const owner = this.window!;
    const view = new WebContentsView({ webPreferences: {
      partition: "persist:workspace-browser", nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false
    } });
    const page: Page = { view, visible: false, state: { id: tab.id, loading: false, canGoBack: false, canGoForward: false }, savingAddress: false, navigationGeneration: 0 };
    this.pages.set(tab.id, page);
    owner.contentView.addChildView(view);
    view.setVisible(false);
    const contents = view.webContents;
    attachWorkspaceShortcuts(owner, contents);
    const publish = (): void => {
      if (contents.isDestroyed()) return;
      page.state.loading = contents.isLoading();
      page.state.canGoBack = contents.navigationHistory.canGoBack();
      page.state.canGoForward = contents.navigationHistory.canGoForward();
      if (!owner.isDestroyed()) owner.webContents.send(channels.browserStateChanged, page.state);
    };
    const savePage = (url: string): void => {
      if (page.savingAddress || !isBrowserUrl(url)) return;
      void this.service.updateBrowserPage(tab.id, { url }).catch((error) => { page.state.error = `Could not save address: ${String(error)}`; publish(); });
      publish();
    };
    contents.on("will-navigate", (event, url) => { if (!isBrowserUrl(url)) event.preventDefault(); });
    contents.on("will-frame-navigate", (event) => { if (!isBrowserUrl(event.url)) event.preventDefault(); });
    contents.on("will-redirect", (event, url) => { if (!isBrowserUrl(url)) event.preventDefault(); });
    contents.on("did-navigate", (_event, url) => savePage(url));
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => { if (mainFrame) savePage(url); });
    contents.on("page-title-updated", (_event, title) => {
      if (!page.savingAddress) void this.service.updateBrowserPage(tab.id, { title }).catch((error) => { page.state.error = `Could not save title: ${String(error)}`; publish(); });
    });
    contents.on("did-start-loading", () => { page.state.error = undefined; publish(); });
    contents.on("did-stop-loading", publish);
    contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      page.state.error = `Unable to load page: ${description}`;
      publish();
    });
    contents.on("render-process-gone", () => { page.state.error = "The page stopped responding. Reload to continue."; publish(); });
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isBrowserUrl(url)) void this.service.createBrowser({ workspaceId: tab.workspaceId, url }).then((created) => {
        if (!owner.isDestroyed()) owner.webContents.send(channels.browserCreated, created);
      }).catch((error) => { page.state.error = `Could not open tab: ${String(error)}`; publish(); });
      return { action: "deny" };
    });
    if (tab.url && isBrowserUrl(tab.url)) this.load(page, tab.url);
  }

  private load(page: Page, url: string): void {
    void page.view.webContents.loadURL(url).catch(() => { /* did-fail-load presents the error. */ });
  }

  async navigate(id: string, url: string): Promise<void> {
    const page = this.pages.get(id);
    if (!page) throw new Error("Browser view no longer exists");
    const generation = ++page.navigationGeneration;
    page.savingAddress = true;
    page.view.webContents.stop();
    try {
      await this.service.navigateBrowser({ id, url });
      if (generation === page.navigationGeneration && !page.view.webContents.isDestroyed()) this.load(page, url);
    } finally { if (generation === page.navigationGeneration) page.savingAddress = false; }
  }

  command(id: string, command: "back" | "forward" | "reload"): void {
    const page = this.pages.get(id);
    if (!page) throw new Error("Browser view no longer exists");
    const contents = page.view.webContents;
    if (command === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (command === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (command === "reload") {
      const tab = this.service.snapshot().browserTabs.find((tab) => tab.id === id);
      if (tab?.url) {
        if (contents.getURL() === tab.url && !page.state.error) contents.reload();
        else this.load(page, tab.url);
      }
    }
  }

  setLayout(layout: BrowserLayoutInput): void {
    if (layout.id && !this.pages.has(layout.id)) throw new Error("Browser view no longer exists");
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
        const next = { x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height))) };
        const current = page.view.getBounds();
        if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height) page.view.setBounds(next);
      }
      const returnFocus = !visible && page.view.webContents.isFocused();
      this.setVisible(page, visible);
      if (returnFocus) this.window.webContents.focus();
    }
  }

  private setVisible(page: Page, visible: boolean): void {
    if (page.visible === visible) return;
    page.view.setVisible(visible);
    page.visible = visible;
  }

  hide(): void {
    this.layout = null;
    for (const page of this.pages.values()) this.setVisible(page, false);
  }

  states(): BrowserState[] { return [...this.pages.values()].map((page) => ({ ...page.state })); }

  private destroy(id: string): void {
    const page = this.pages.get(id);
    if (!page) return;
    this.pages.delete(id);
    if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(page.view);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false });
  }
}
