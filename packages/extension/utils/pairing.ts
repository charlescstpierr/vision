import {
  PAIRING_DONE_ATTRIBUTE,
  PAIRING_PAYLOAD_ELEMENT_ID,
  PENDING_PAIRING_STORAGE_KEY,
  PENDING_PAIRING_TTL_MS,
  isLoopbackOrigin,
  parsePairingPayload,
  type PairingPayload,
  type PendingPairing,
} from '@vizion/shared';

/**
 * Reads the connection details the local server's `/pair` page embeds.
 *
 * Page content is never trusted, so three things must hold before anything is
 * read: we are the top-level document (a remote page must not be able to frame
 * the pairing URL and have us harvest it), the origin is loopback (the only
 * address the server binds to), and the payload itself passes full validation.
 * Any failure returns null rather than throwing -- this runs on every page.
 */
export function readPairingPayload(doc: Document, win: Window): PairingPayload | null {
  if (win.top !== win) return null;
  if (!isLoopbackOrigin(win.location.origin)) return null;

  const el = doc.getElementById(PAIRING_PAYLOAD_ELEMENT_ID);
  if (!el || el.tagName !== 'SCRIPT') return null;

  try {
    return parsePairingPayload(JSON.parse(el.textContent ?? ''));
  } catch {
    return null;
  }
}

/**
 * Stores a payload as *pending*: the side panel shows it for confirmation
 * before it becomes the live setting, so a forged payload can at worst raise a
 * prompt naming a project the user does not recognise.
 */
export async function storePendingPairing(payload: PairingPayload, now = Date.now()): Promise<void> {
  const pending: PendingPairing = { ...payload, seenAt: now };
  await chrome.storage.local.set({ [PENDING_PAIRING_STORAGE_KEY]: pending });
}

/** Narrows a stored value back to a `PendingPairing`, dropping anything stale or malformed. */
export function readStoredPending(value: unknown, now = Date.now()): PendingPairing | null {
  if (typeof value !== 'object' || value === null) return null;
  const payload = parsePairingPayload(value);
  if (!payload) return null;
  const { seenAt } = value as { seenAt?: unknown };
  if (typeof seenAt !== 'number' || !Number.isFinite(seenAt)) return null;
  if (now - seenAt > PENDING_PAIRING_TTL_MS) return null;
  return { ...payload, seenAt };
}

/**
 * Whole content-script side of pairing: read, store, and tell the page it was
 * seen so it can stop saying "en attente". A no-op on every page that is not
 * the pairing page, which is all of them.
 */
export async function handlePairingPage(doc: Document = document, win: Window = window): Promise<boolean> {
  const payload = readPairingPayload(doc, win);
  if (!payload) return false;
  await storePendingPairing(payload);
  doc.documentElement.setAttribute(PAIRING_DONE_ATTRIBUTE, '');
  return true;
}
