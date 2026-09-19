import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024; // 2 MiB

const DATA_URL_RE = /^data:image\/(jpeg|png);base64,(.*)$/s;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type DecodedScreenshot = { buffer: Buffer; ext: 'jpg' | 'png' };

/**
 * Decodes a `data:image/jpeg;base64,...` or `data:image/png;base64,...` URL
 * (the two formats the side panel's capture can produce) into raw bytes.
 * Rejects any other mime type, malformed base64, or a payload over 2 MiB.
 */
export function decodeScreenshot(dataUrl: string): DecodedScreenshot | { error: string } {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return { error: 'Capture invalide.' };

  const [, mime, base64] = match;
  if (!base64 || base64.length % 4 !== 0 || !BASE64_RE.test(base64)) {
    return { error: 'Capture invalide.' };
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) return { error: 'Capture invalide.' };
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    return { error: 'Capture trop volumineuse (max 2 Mo).' };
  }

  return { buffer, ext: mime === 'jpeg' ? 'jpg' : 'png' };
}

/**
 * Writes `buffer` to a fresh `vizion-shot-*` temp directory (outside the
 * project, so the agent can see it without it ending up in a diff) and
 * returns the absolute path to the file. The caller is responsible for
 * removing the directory (`path.dirname(result)`) once the run is done.
 */
export async function writeScreenshotFile(buffer: Buffer, ext: 'jpg' | 'png'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vizion-shot-'));
  const name = `vizion-shot-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const file = path.join(dir, name);
  await fs.writeFile(file, buffer);
  return file;
}
