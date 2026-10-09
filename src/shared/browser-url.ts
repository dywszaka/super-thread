/** Only network pages may enter the embedded browser, including redirects and popups. */
export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (!value || value.length > 8192 || /[\s\\]/.test(value)) throw new Error("Enter an HTTP or HTTPS address");
  let candidate = value;
  if (!/^https?:\/\//i.test(value)) {
    // A hostname with a numeric port is not a URL scheme.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(value)) throw new Error("Only HTTP and HTTPS addresses are supported");
    const parsed = new URL(`https://${value}`);
    const host = parsed.hostname.toLowerCase();
    const local = host === "localhost" || host.endsWith(".localhost") || host.startsWith("127.") || host === "[::1]";
    candidate = `${local ? "http" : "https"}://${value}`;
  }
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error("Enter an HTTP or HTTPS address without credentials");
  return url.href;
}

export function isBrowserUrl(value: string): boolean {
  try { return /^https?:\/\//i.test(value) && Boolean(normalizeBrowserUrl(value)); }
  catch { return false; }
}
