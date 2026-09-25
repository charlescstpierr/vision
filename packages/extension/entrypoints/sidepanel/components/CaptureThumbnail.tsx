import { useEffect, useRef, type CSSProperties } from 'react';
import type { Screenshot } from '@vizion/shared';
import type { Annotation } from '../../../utils/annotations.js';
import { paintCapture } from '../../../utils/annotation-render.js';
import { useCaptureBitmap } from '../hooks/useCaptureBitmap.js';

type Props = {
  screenshot: Screenshot;
  /** The marks the capture was sent with. */
  marks: readonly Annotation[];
};

const thumbnailStyle: CSSProperties = {
  display: 'block',
  width: 'auto',
  height: 'auto',
  maxWidth: 120,
  maxHeight: 120,
  boxShadow: '0 0 0 1px #ddd',
};

/** Read-only picture of a capture sent with a run, its marks painted exactly as they went out. */
export default function CaptureThumbnail({ screenshot, marks }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capture = useCaptureBitmap(screenshot.dataUrl);
  const { width, height } = screenshot;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || capture.status !== 'ready') return;
    paintCapture(ctx, { image: capture.bitmap, width, height }, marks);
  }, [capture, marks, width, height]);

  if (capture.status === 'error') {
    return <span style={{ fontSize: 11, color: '#a83232' }}>Aperçu indisponible : {capture.message}</span>;
  }
  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      role="img"
      aria-label="Capture envoyée avec le run"
      style={thumbnailStyle}
    />
  );
}
