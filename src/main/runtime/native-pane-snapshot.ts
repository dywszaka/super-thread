import type { WebContentsView } from "electron";

/** Capture only the visible viewport; snapshots stay in memory and expose no page APIs. */
export async function captureNativePane(view: WebContentsView | undefined, visible: boolean): Promise<string | null> {
  if (!view || !visible || view.webContents.isDestroyed()) return null;
  try {
    const image = await view.webContents.capturePage();
    return view.webContents.isDestroyed() || image.isEmpty() ? null : image.toDataURL();
  } catch { return null; } // Teardown or a crashed page must not prevent menus from opening.
}
