function toHexByte(n: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return clamped.toString(16).padStart(2, '0');
}

/**
 * Converts a CSS color to `#rrggbb`, for prefilling `<input type="color">`.
 * Accepts `rgb(r, g, b)` / `rgba(r, g, b, a)` (as returned by
 * `getComputedStyle`) and already-hex colors (returned as-is, expanding
 * `#rgb` to `#rrggbb`). Anything else it can't parse falls back to `#000000`.
 */
export function rgbToHex(color: string): string {
  const trimmed = color.trim();

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (hexMatch) {
    const hex = hexMatch[1]!;
    if (hex.length === 3) {
      return `#${hex
        .split('')
        .map((c) => c + c)
        .join('')}`.toLowerCase();
    }
    return `#${hex}`.toLowerCase();
  }

  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(trimmed);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    return `#${toHexByte(Number(r))}${toHexByte(Number(g))}${toHexByte(Number(b))}`;
  }

  return '#000000';
}
