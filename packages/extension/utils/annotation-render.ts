import type { Screenshot } from '@vizion/shared';
import {
  arrowHeadOf,
  badgeCenterOf,
  ellipseOf,
  strokeWidthFor,
  type Annotation,
  type AnnotationTool,
  type ImageSize,
  type Point,
} from './annotations.js';
import { CAPTURE_JPEG_QUALITY } from './screenshot.js';

/**
 * Drawn into the image the agent reads, not panel chrome: a saturated red
 * that stands out on typical page content, over a white halo so a mark
 * still reads on red or dark backgrounds.
 */
const MARK_COLOR = '#ff3b30';
const HALO_COLOR = 'rgba(255, 255, 255, 0.9)';
const BADGE_TEXT_COLOR = '#ffffff';
/** Fill of the grab handles, which only ever appear on the preview. */
const HANDLE_FILL = '#ffffff';

/** The parts of `CanvasRenderingContext2D` used to paint a capture and its marks. */
export type PaintContext = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'drawImage'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'ellipse'
  | 'arc'
  | 'stroke'
  | 'fill'
  | 'fillText'
  | 'strokeRect'
  | 'setLineDash'
  | 'strokeStyle'
  | 'fillStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
>;

/** A decoded capture, and the size its pixels — and every mark on it — are expressed in. */
export interface CaptureImage extends ImageSize {
  readonly image: CanvasImageSource;
}

/** The parts of `HTMLCanvasElement` used to flatten marks into the capture sent with a run. */
export interface ExportCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): PaintContext | null;
  toDataURL(type: string, quality: number): string;
}

type MarkPainter = (ctx: PaintContext, mark: Annotation, size: number) => void;

/** Adds a mark's outline to the current path; `size` is the stroke width. */
const TRACERS: Record<AnnotationTool, MarkPainter> = {
  arrow: (ctx, mark, lineWidth) => {
    const [left, right] = arrowHeadOf(mark, lineWidth);
    ctx.moveTo(mark.from.x, mark.from.y);
    ctx.lineTo(mark.to.x, mark.to.y);
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(mark.to.x, mark.to.y);
    ctx.lineTo(right.x, right.y);
  },
  circle: (ctx, mark) => {
    const { cx, cy, rx, ry } = ellipseOf(mark);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
  },
};

/** What a selected mark shows besides its end handles — the box a circle's handles resize; `size` is the handle radius. */
const HANDLE_GUIDES: Record<AnnotationTool, MarkPainter> = {
  arrow: () => undefined,
  circle: (ctx, mark, radius) => {
    ctx.setLineDash([radius, radius]);
    ctx.strokeRect(
      Math.min(mark.from.x, mark.to.x),
      Math.min(mark.from.y, mark.to.y),
      Math.abs(mark.to.x - mark.from.x),
      Math.abs(mark.to.y - mark.from.y),
    );
    ctx.setLineDash([]);
  },
};

interface Badge {
  readonly center: Point;
  readonly radius: number;
  readonly label: string;
}

/** Strokes the current path as a mark: a white halo, then the mark colour on top of it. */
function strokeMark(ctx: PaintContext, lineWidth: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = lineWidth * 2;
  ctx.stroke();
  ctx.strokeStyle = MARK_COLOR;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Paints a mark's number in a red disc, so the prompt can refer to the mark by it. */
function paintBadge(ctx: PaintContext, badge: Badge, lineWidth: number): void {
  ctx.beginPath();
  ctx.arc(badge.center.x, badge.center.y, badge.radius, 0, 2 * Math.PI);
  ctx.fillStyle = MARK_COLOR;
  ctx.fill();
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = Math.max(1.5, lineWidth / 2);
  ctx.stroke();
  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `bold ${Math.round(badge.radius * 1.25)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badge.label, badge.center.x, badge.center.y);
}

/**
 * Paints the capture stretched to exactly its declared size, then its marks
 * and their numbers. This is the one drawing path shared by the preview, the
 * sent thumbnail and the exported JPEG, so what the panel shows is what the
 * agent gets.
 */
export function paintCapture(ctx: PaintContext, capture: CaptureImage, marks: readonly Annotation[]): void {
  ctx.drawImage(capture.image, 0, 0, capture.width, capture.height);
  const lineWidth = strokeWidthFor(capture);
  for (const mark of marks) {
    ctx.beginPath();
    TRACERS[mark.tool](ctx, mark, lineWidth);
    strokeMark(ctx, lineWidth);
  }
  // Numbers go on last so a later mark never covers an earlier one's number.
  const radius = lineWidth * 2.5 + 4;
  marks.forEach((mark, index) => {
    paintBadge(ctx, { center: badgeCenterOf(mark, radius, capture), radius, label: String(index + 1) }, lineWidth);
  });
}

/**
 * Editing affordance for the selected mark, drawn on the preview only and
 * never exported: a dashed guide around a circle's box and a grab handle on
 * each end. `radius` is in capture pixels, sized by the caller to look the
 * same on screen whatever the preview's scale.
 */
export function paintHandles(ctx: PaintContext, mark: Annotation, radius: number): void {
  ctx.strokeStyle = MARK_COLOR;
  ctx.lineWidth = Math.max(1, radius / 3);
  HANDLE_GUIDES[mark.tool](ctx, mark, radius);
  for (const end of [mark.from, mark.to]) {
    ctx.beginPath();
    ctx.arc(end.x, end.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = HANDLE_FILL;
    ctx.fill();
    ctx.stroke();
  }
}

/** Decodes a capture's data URL into a bitmap a canvas can draw (the path `captureElementScreenshot` takes too). */
export async function decodeCapture(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

/**
 * Flattens the marks into the capture: resizes `canvas` to the capture,
 * paints it, and encodes the result the way captures are always sent — a
 * JPEG exactly `width` × `height`, so the payload's size matches its bytes.
 */
export function encodeAnnotatedCapture(
  canvas: ExportCanvas,
  capture: CaptureImage,
  marks: readonly Annotation[],
): Screenshot {
  canvas.width = capture.width;
  canvas.height = capture.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('contexte de canevas indisponible');
  }
  paintCapture(ctx, capture, marks);
  return {
    dataUrl: canvas.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * The capture to attach to a run. Marks are flattened into it only here, at
 * send time — until then they stay editable geometry. With no marks the
 * staged capture goes out untouched rather than through a second JPEG pass.
 */
export async function renderAnnotatedScreenshot(
  screenshot: Screenshot,
  marks: readonly Annotation[],
): Promise<Screenshot> {
  if (marks.length === 0) return screenshot;
  const image = await decodeCapture(screenshot.dataUrl);
  try {
    const capture = { image, width: screenshot.width, height: screenshot.height };
    return encodeAnnotatedCapture(document.createElement('canvas'), capture, marks);
  } finally {
    image.close();
  }
}
