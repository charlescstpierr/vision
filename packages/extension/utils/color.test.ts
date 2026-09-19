import { describe, expect, it } from 'vitest';
import { rgbToHex } from './color.js';

describe('rgbToHex', () => {
  it('converts rgb(...) to lowercase hex', () => {
    expect(rgbToHex('rgb(255, 0, 0)')).toBe('#ff0000');
  });

  it('converts rgba(...) ignoring alpha', () => {
    expect(rgbToHex('rgba(0, 128, 255, 0.5)')).toBe('#0080ff');
  });

  it('rounds fractional channel values', () => {
    expect(rgbToHex('rgb(0.4, 254.6, 10)')).toBe('#00ff0a');
  });

  it('passes through an already-hex color, lowercased', () => {
    expect(rgbToHex('#ABC123')).toBe('#abc123');
  });

  it('expands short hex to long hex', () => {
    expect(rgbToHex('#0f0')).toBe('#00ff00');
  });

  it('falls back to black for unparseable input', () => {
    expect(rgbToHex('transparent')).toBe('#000000');
  });
});
