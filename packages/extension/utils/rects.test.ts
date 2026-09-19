import { describe, expect, it } from 'vitest';
import { unionVisibleRects } from './rects.js';

const VIEWPORT_W = 1000;
const VIEWPORT_H = 800;

describe('unionVisibleRects', () => {
  it('returns null when one rect is entirely above the viewport and one entirely below', () => {
    const above = { x: 10, y: -200, width: 100, height: 100 };
    const below = { x: 10, y: 900, width: 100, height: 100 };
    expect(unionVisibleRects([above, below], VIEWPORT_W, VIEWPORT_H)).toBeNull();
  });

  it('returns the clipped rect when only one of two is visible', () => {
    const visible = { x: 10, y: 10, width: 50, height: 50 };
    const above = { x: 10, y: -200, width: 100, height: 100 };
    expect(unionVisibleRects([above, visible], VIEWPORT_W, VIEWPORT_H)).toEqual(visible);
  });

  it('unions two visible rects', () => {
    const a = { x: 10, y: 10, width: 50, height: 50 };
    const b = { x: 100, y: 100, width: 50, height: 50 };
    expect(unionVisibleRects([a, b], VIEWPORT_W, VIEWPORT_H)).toEqual({
      x: 10,
      y: 10,
      width: 140,
      height: 140,
    });
  });

  it('clips a rect that straddles the viewport edge before unioning', () => {
    const straddling = { x: -20, y: 10, width: 50, height: 50 };
    expect(unionVisibleRects([straddling], VIEWPORT_W, VIEWPORT_H)).toEqual({
      x: 0,
      y: 10,
      width: 30,
      height: 50,
    });
  });

  it('returns null for an empty list', () => {
    expect(unionVisibleRects([], VIEWPORT_W, VIEWPORT_H)).toBeNull();
  });
});
