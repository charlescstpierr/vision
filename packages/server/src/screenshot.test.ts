import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeScreenshot, writeScreenshotFile } from './screenshot.js';

// A 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
// A minimal valid JPEG.
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

describe('decodeScreenshot', () => {
  it('accepts a jpeg data URL', () => {
    const result = decodeScreenshot(`data:image/jpeg;base64,${JPEG_BASE64}`);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ext).toBe('jpg');
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('accepts a png data URL', () => {
    const result = decodeScreenshot(`data:image/png;base64,${PNG_1X1_BASE64}`);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ext).toBe('png');
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('rejects a gif data URL', () => {
    const result = decodeScreenshot(`data:image/gif;base64,${PNG_1X1_BASE64}`);
    expect(result).toEqual({ error: 'Capture invalide.' });
  });

  it('rejects a payload over 2 MiB', () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString('base64');
    const result = decodeScreenshot(`data:image/png;base64,${big}`);
    expect(result).toEqual({ error: 'Capture trop volumineuse (max 2 Mo).' });
  });

  it('rejects malformed base64', () => {
    const result = decodeScreenshot('data:image/png;base64,not-valid-base64!!');
    expect(result).toEqual({ error: 'Capture invalide.' });
  });

  it('rejects a string that is not a data URL at all', () => {
    const result = decodeScreenshot('not a data url');
    expect(result).toEqual({ error: 'Capture invalide.' });
  });
});

describe('writeScreenshotFile', () => {
  it('writes the buffer under a fresh temp dir with the right extension', async () => {
    const buffer = Buffer.from('hello');
    const file = await writeScreenshotFile(buffer, 'png');
    try {
      expect(path.basename(file)).toMatch(/^vizion-shot-[0-9a-f]+\.png$/);
      expect(path.basename(path.dirname(file))).toMatch(/^vizion-shot-/);
      const written = await fs.readFile(file);
      expect(written.equals(buffer)).toBe(true);
    } finally {
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('uses the jpg extension when asked', async () => {
    const file = await writeScreenshotFile(Buffer.from('x'), 'jpg');
    try {
      expect(file.endsWith('.jpg')).toBe(true);
    } finally {
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    }
  });
});
