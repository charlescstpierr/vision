import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIRING_DONE_ATTRIBUTE, PAIRING_PAYLOAD_ELEMENT_ID, PENDING_PAIRING_TTL_MS } from '@vizion/shared';
import { handlePairingPage, readPairingPayload, readStoredPending } from './pairing.js';

const payload = { token: 'a'.repeat(32), port: 7331, cwd: '/home/u/proj', version: '0.1.0' };

function pageWith(json: string, origin = 'http://127.0.0.1:7331'): { doc: Document; win: Window } {
  const doc = document.implementation.createHTMLDocument('t');
  const script = doc.createElement('script');
  script.type = 'application/json';
  script.id = PAIRING_PAYLOAD_ELEMENT_ID;
  script.textContent = json;
  doc.body.appendChild(script);
  const win = { location: { origin } } as unknown as Window;
  (win as { top?: unknown }).top = win;
  return { doc, win };
}

describe('readPairingPayload', () => {
  it('reads a well-formed payload from a loopback top-level page', () => {
    const { doc, win } = pageWith(JSON.stringify(payload));
    expect(readPairingPayload(doc, win)).toEqual(payload);
  });

  it('accepts localhost as well as 127.0.0.1', () => {
    const { doc, win } = pageWith(JSON.stringify(payload), 'http://localhost:7331');
    expect(readPairingPayload(doc, win)).toEqual(payload);
  });

  it('ignores a payload served from any non-loopback origin', () => {
    for (const origin of ['https://evil.example', 'http://evil.example', 'https://127.0.0.1.evil.com']) {
      const { doc, win } = pageWith(JSON.stringify(payload), origin);
      expect(readPairingPayload(doc, win)).toBeNull();
    }
  });

  it('ignores a payload in a sub-frame, so a remote page cannot frame the pairing URL to harvest it', () => {
    const { doc, win } = pageWith(JSON.stringify(payload));
    (win as { top?: unknown }).top = { different: true };
    expect(readPairingPayload(doc, win)).toBeNull();
  });

  it('returns null rather than throwing on malformed or hostile content', () => {
    for (const body of ['', 'not json', '[]', 'null', JSON.stringify({ token: 'nope', port: 7331 })]) {
      const { doc, win } = pageWith(body);
      expect(readPairingPayload(doc, win)).toBeNull();
    }
  });

  it('rejects a port outside the usable range and a non-hex token', () => {
    for (const bad of [{ ...payload, port: 0 }, { ...payload, port: 70000 }, { ...payload, token: 'XYZ' }]) {
      const { doc, win } = pageWith(JSON.stringify(bad));
      expect(readPairingPayload(doc, win)).toBeNull();
    }
  });

  it('ignores the marker id on an element that is not a script tag', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const div = doc.createElement('div');
    div.id = PAIRING_PAYLOAD_ELEMENT_ID;
    div.textContent = JSON.stringify(payload);
    doc.body.appendChild(div);
    const win = { location: { origin: 'http://127.0.0.1:7331' } } as unknown as Window;
    (win as { top?: unknown }).top = win;
    expect(readPairingPayload(doc, win)).toBeNull();
  });
});

describe('readStoredPending', () => {
  it('accepts a fresh, well-formed entry', () => {
    const now = 1_000_000;
    expect(readStoredPending({ ...payload, seenAt: now }, now)).toEqual({ ...payload, seenAt: now });
  });

  it('drops an entry older than the TTL', () => {
    const now = 1_000_000;
    expect(readStoredPending({ ...payload, seenAt: now - PENDING_PAIRING_TTL_MS - 1 }, now)).toBeNull();
  });

  it('drops malformed entries', () => {
    expect(readStoredPending(null)).toBeNull();
    expect(readStoredPending({ ...payload })).toBeNull(); // no seenAt
    expect(readStoredPending({ seenAt: Date.now() })).toBeNull(); // no payload
  });
});

describe('handlePairingPage', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
  });

  it('stores the pairing and marks the page as seen', async () => {
    const { doc, win } = pageWith(JSON.stringify(payload));
    expect(await handlePairingPage(doc, win)).toBe(true);
    expect(doc.documentElement.hasAttribute(PAIRING_DONE_ATTRIBUTE)).toBe(true);
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on an ordinary page, and touches neither storage nor the DOM', async () => {
    const doc = document.implementation.createHTMLDocument('t');
    const win = { location: { origin: 'https://example.com' } } as unknown as Window;
    (win as { top?: unknown }).top = win;
    expect(await handlePairingPage(doc, win)).toBe(false);
    expect(doc.documentElement.hasAttribute(PAIRING_DONE_ATTRIBUTE)).toBe(false);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
