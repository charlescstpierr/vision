import { describe, expect, it } from 'vitest';
import { assertSameTab, computeCrop, computeTargetSize } from './screenshot.js';

describe('computeCrop', () => {
  it('scales the rect by dpr 1 and pads every side', () => {
    const crop = computeCrop({ x: 10, y: 10, width: 100, height: 50 }, 1, 1000, 1000, 8);
    expect(crop).toEqual({ x: 2, y: 2, width: 116, height: 66 });
  });

  it('scales by devicePixelRatio 2 before padding', () => {
    const crop = computeCrop({ x: 10, y: 10, width: 100, height: 50 }, 2, 2000, 2000, 8);
    expect(crop).toEqual({ x: 12, y: 12, width: 216, height: 116 });
  });

  it('clamps a crop larger than the image to the image bounds', () => {
    const crop = computeCrop({ x: 0, y: 0, width: 50, height: 50 }, 1, 40, 40, 8);
    expect(crop).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it('clamps padding that would overflow the right/bottom edge', () => {
    const crop = computeCrop({ x: 90, y: 90, width: 20, height: 20 }, 1, 100, 100, 8);
    expect(crop).toEqual({ x: 82, y: 82, width: 18, height: 18 });
  });

  it('uses a padding of 8 by default', () => {
    const crop = computeCrop({ x: 10, y: 10, width: 100, height: 50 }, 1, 1000, 1000);
    expect(crop).toEqual({ x: 2, y: 2, width: 116, height: 66 });
  });

  it('returns null for a null rect', () => {
    expect(computeCrop(null, 1, 100, 100)).toBeNull();
  });

  it('returns null for a zero-size rect', () => {
    expect(computeCrop({ x: 0, y: 0, width: 0, height: 10 }, 1, 100, 100)).toBeNull();
  });
});

describe('computeTargetSize', () => {
  it('leaves a size at maxSide unchanged', () => {
    expect(computeTargetSize(400, 300, 800)).toEqual({ width: 400, height: 300 });
  });

  it('leaves a size already under maxSide unchanged', () => {
    expect(computeTargetSize(100, 50, 800)).toEqual({ width: 100, height: 50 });
  });

  it('downscales a landscape image, keeping aspect ratio', () => {
    expect(computeTargetSize(1600, 800, 800)).toEqual({ width: 800, height: 400 });
  });

  it('downscales a portrait image, keeping aspect ratio', () => {
    expect(computeTargetSize(800, 1600, 800)).toEqual({ width: 400, height: 800 });
  });

  it('uses a default maxSide of 800 when omitted', () => {
    expect(computeTargetSize(1000, 500)).toEqual({ width: 800, height: 400 });
  });
});

describe('assertSameTab', () => {
  it('does not throw when the active tab still matches', () => {
    expect(() => assertSameTab(7, 7)).not.toThrow();
  });

  it('throws a French error when the active tab id differs', () => {
    expect(() => assertSameTab(7, 8)).toThrow("Capture impossible : l'onglet actif a changé.");
  });

  it('throws when the active tab id is undefined', () => {
    expect(() => assertSameTab(7, undefined)).toThrow("Capture impossible : l'onglet actif a changé.");
  });
});
