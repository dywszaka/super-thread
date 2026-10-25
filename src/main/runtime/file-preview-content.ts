import MarkdownIt from "markdown-it";
import { extname } from "node:path";

const markdown = new MarkdownIt({ html: false, linkify: true });
export const staticPreviewCsp = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
export const previewMimeType = (path: string): string => ({
  ".pdf": "application/pdf", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf"
}[extname(path).toLowerCase()] ?? "application/octet-stream");

export function renderPreviewMarkdown(source: string, dark: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${dark ? "dark" : "light"}"><style>
    :root{color-scheme:${dark ? "dark" : "light"}}body{margin:0;padding:32px;font:15px/1.65 -apple-system,BlinkMacSystemFont,sans-serif;background:${dark ? "#1c1d1f" : "#fff"};color:${dark ? "#eee" : "#202124"}}
    article{max-width:800px;margin:auto;overflow-wrap:anywhere}h1,h2,h3{line-height:1.3}h1{font-size:28px}h2{font-size:22px}h3{font-size:18px}
    img{max-width:100%}a{color:${dark ? "#80baff" : "#0066cc"}}pre{overflow:auto;padding:16px;background:${dark ? "#292a2d" : "#f3f4f5"};border-radius:6px}code{font:13px/1.6 ui-monospace,monospace}
    table{border-collapse:collapse;display:block;overflow:auto}td,th{border:1px solid ${dark ? "#555" : "#ccc"};padding:6px 12px}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #888;color:${dark ? "#bbb" : "#555"}}
    </style></head><body><article>${markdown.render(source)}</article></body></html>`;
}

/** Range responses let the native PDF viewer seek without another SSH transfer. */
export function previewByteResponse(bytes: Buffer, contentType: string, range: string | null, method = "GET"): Response {
  const headers = new Headers({ "Content-Type": contentType, "Content-Length": String(bytes.length), "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (contentType.startsWith("text/html") || contentType === "image/svg+xml") headers.set("Content-Security-Policy", staticPreviewCsp);
  let status = 200, body = bytes;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = match?.[1] ? Number(match[1]) : 0;
    let end = match?.[2] ? Number(match[2]) : bytes.length - 1;
    if (match && !match[1] && match[2]) { start = Math.max(0, bytes.length - Number(match[2])); end = bytes.length - 1; }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
      headers.set("Content-Range", `bytes */${bytes.length}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    end = Math.min(end, bytes.length - 1);
    body = bytes.subarray(start, end + 1);
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    headers.set("Content-Length", String(body.length));
  }
  return new Response(method === "HEAD" ? null : new Uint8Array(body), { status, headers });
}
