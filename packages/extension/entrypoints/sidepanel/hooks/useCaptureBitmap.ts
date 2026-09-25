import { useEffect, useState } from 'react';
import { decodeCapture } from '../../../utils/annotation-render.js';

export type DecodedCapture =
  | { status: 'loading' }
  | { status: 'ready'; bitmap: ImageBitmap }
  | { status: 'error'; message: string };

const LOADING: DecodedCapture = { status: 'loading' };

/**
 * Decodes a capture's data URL so it can be painted on a canvas, closing the
 * bitmap once the capture changes or the component unmounts. Only ever
 * returns a bitmap for the current `dataUrl`, never a stale, closed one.
 */
export function useCaptureBitmap(dataUrl: string): DecodedCapture {
  const [decoded, setDecoded] = useState<{ dataUrl: string; capture: DecodedCapture } | null>(null);

  useEffect(() => {
    let current = true;
    let bitmap: ImageBitmap | null = null;
    void decodeCapture(dataUrl).then(
      (result) => {
        if (!current) {
          result.close();
          return;
        }
        bitmap = result;
        setDecoded({ dataUrl, capture: { status: 'ready', bitmap: result } });
      },
      (err: unknown) => {
        if (!current) return;
        const message = err instanceof Error ? err.message : String(err);
        setDecoded({ dataUrl, capture: { status: 'error', message } });
      },
    );
    return () => {
      current = false;
      bitmap?.close();
      setDecoded(null);
    };
  }, [dataUrl]);

  return decoded?.dataUrl === dataUrl ? decoded.capture : LOADING;
}
