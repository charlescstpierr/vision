/**
 * True for http(s) URLs that point at a local dev server: `localhost`,
 * `127.0.0.1`, the IPv6 loopback `[::1]`, or any `*.localhost` hostname.
 * Used to gate Source mode, which only makes sense against a project the
 * Vizion CLI is serving locally — a remote page stays in Overlay mode even
 * while the extension is connected to the local server.
 */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const hostname = parsed.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}
