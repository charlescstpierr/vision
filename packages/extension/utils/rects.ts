export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clips a viewport-relative rect to `0,0 .. viewportW,viewportH`; `null` if nothing is left. */
function clipToViewport(rect: Rect, viewportW: number, viewportH: number): Rect | null {
  const left = Math.max(rect.x, 0);
  const top = Math.max(rect.y, 0);
  const right = Math.min(rect.x + rect.width, viewportW);
  const bottom = Math.min(rect.y + rect.height, viewportH);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Clips every rect to the viewport individually, drops the ones left empty
 * (entirely off-screen), then unions what remains into a single bounding
 * box. Returns `null` when none of the rects are visible.
 */
export function unionVisibleRects(rects: Rect[], viewportW: number, viewportH: number): Rect | null {
  const visible = rects
    .map((rect) => clipToViewport(rect, viewportW, viewportH))
    .filter((rect): rect is Rect => rect !== null);

  if (visible.length === 0) return null;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of visible) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
