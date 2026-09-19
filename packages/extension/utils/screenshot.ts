import type { RectReply, Screenshot } from '@vizion/shared';

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Converts a content-script rect (viewport CSS pixels) into a crop box in
 * image pixels — as captured by `chrome.tabs.captureVisibleTab`, which is
 * already rendered at `devicePixelRatio` resolution: scales by `dpr`, adds
 * `padding` image pixels on every side, then clamps to the image bounds.
 * Returns `null` for a missing/empty/degenerate rect.
 */
export function computeCrop(
  rect: { x: number; y: number; width: number; height: number } | null,
  dpr: number,
  imageWidth: number,
  imageHeight: number,
  padding = 8,
): CropBox | null {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  const scaledX = rect.x * dpr;
  const scaledY = rect.y * dpr;
  const scaledRight = scaledX + rect.width * dpr;
  const scaledBottom = scaledY + rect.height * dpr;

  const left = Math.max(0, scaledX - padding);
  const top = Math.max(0, scaledY - padding);
  const right = Math.min(imageWidth, scaledRight + padding);
  const bottom = Math.min(imageHeight, scaledBottom + padding);

  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;

  return { x: left, y: top, width, height };
}

/**
 * Downscales `width`×`height` so its longest side is at most `maxSide`,
 * keeping the aspect ratio. Left unchanged (only rounded) if it already
 * fits.
 */
export function computeTargetSize(
  width: number,
  height: number,
  maxSide = 800,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide || longest <= 0) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxSide / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Guards against the active tab changing out from under a capture (the user
 * switched tabs while `captureVisibleTab` was in flight, say). Pure so it can
 * be tested without mocking `chrome.tabs`.
 */
export function assertSameTab(expectedId: number, activeId: number | undefined): void {
  if (activeId !== expectedId) {
    throw new Error("Capture impossible : l'onglet actif a changé.");
  }
}

async function activeTabId(windowId: number): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab?.id;
}

/**
 * Captures the visible tab, crops it to the selected element(s) — as
 * measured by the content script via `vizion:get-rect` — and downscales the
 * result for attaching to a run. Every failure throws a French `Error`
 * describing what went wrong.
 */
export async function captureElementScreenshot(
  tabId: number,
  windowId: number,
  selectors: string[],
): Promise<Screenshot> {
  let reply: RectReply;
  try {
    reply = (await chrome.tabs.sendMessage(tabId, {
      type: 'vizion:get-rect',
      selectors,
    })) as RectReply;
  } catch (err) {
    throw new Error(`Capture impossible : ${reasonOf(err)}`);
  }

  if (!reply?.rect) {
    throw new Error('Capture impossible : élément hors de la zone visible');
  }

  assertSameTab(tabId, await activeTabId(windowId));

  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (err) {
    throw new Error(`Capture impossible : ${reasonOf(err)}`);
  }

  assertSameTab(tabId, await activeTabId(windowId));

  let bitmap: ImageBitmap;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new Error(`Capture impossible : ${reasonOf(err)}`);
  }

  const crop = computeCrop(reply.rect, reply.devicePixelRatio, bitmap.width, bitmap.height);
  if (!crop) {
    throw new Error('Capture impossible : zone de sélection vide');
  }

  const target = computeTargetSize(crop.width, crop.height);

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Capture impossible : contexte de canevas indisponible');
  }
  ctx.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, target.width, target.height);

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.85),
    width: target.width,
    height: target.height,
  };
}
