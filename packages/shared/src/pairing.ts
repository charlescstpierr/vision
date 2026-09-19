/**
 * One-click pairing between the local server and the extension, replacing the
 * copy-and-paste of a 32-character token (see docs/PLAN.md 3.2).
 *
 * The flow: `vizion` prints a URL carrying a single-use code. Opening it in the
 * browser serves a page that embeds the connection details in a `<script
 * type="application/json">` tag; the content script reads that tag, checks it
 * came from a loopback origin in the top frame, and stores it as a *pending*
 * pairing. The side panel then asks the user to confirm before it becomes the
 * live setting -- so a page that forges the payload can at worst raise a prompt
 * naming a project the user does not recognise, never silently repoint the
 * extension at someone else's server.
 */

/** `id` of the JSON script tag the pairing page embeds and the content script reads. */
export const PAIRING_PAYLOAD_ELEMENT_ID = 'vizion-pairing-payload';

/** Attribute the content script sets on `<html>` once it has stored the payload, so the page can say so. */
export const PAIRING_DONE_ATTRIBUTE = 'data-vizion-paired';

/** `chrome.storage.local` key holding a pairing awaiting the user's confirmation. */
export const PENDING_PAIRING_STORAGE_KEY = 'vizion:pending-pairing';

/** What the pairing page embeds, and what the side panel shows before confirming. */
export interface PairingPayload {
  token: string;
  port: number;
  /** The project directory the server was started in, shown so the user can recognise it. */
  cwd: string;
  version: string;
}

/** A pairing read off a page, kept until the user confirms or dismisses it. */
export interface PendingPairing extends PairingPayload {
  /** When the content script stored it, so a stale one can be ignored. */
  seenAt: number;
}

/** How long a stored pending pairing stays offerable before it is ignored. */
export const PENDING_PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Narrows unknown JSON (page-controlled, so never trusted) to a `PairingPayload`.
 * Every field is checked: the token must look like the server's hex token, and
 * the port must be a usable TCP port.
 */
export function parsePairingPayload(value: unknown): PairingPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const { token, port, cwd, version } = value as Record<string, unknown>;
  if (typeof token !== 'string' || !/^[0-9a-f]{16,128}$/.test(token)) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) return null;
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return null;
  return { token, port, cwd, version };
}

/**
 * True for the origins the pairing page can legitimately be served from: the
 * loopback interface, which is the only address the server binds to. Anything
 * else embedding the payload is a forgery and is ignored outright.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== 'http:') return false;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}
