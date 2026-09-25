import type { Screenshot } from '@vizion/shared';

/** The marks the side panel can draw on a staged capture. */
export type AnnotationTool = 'arrow' | 'circle';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * One mark on a capture, in the capture's own pixels (`Screenshot.width` ×
 * `Screenshot.height`), never in the preview's CSS pixels: an arrow points
 * from `from` to its head at `to`; a circle is the ellipse inscribed in the
 * box whose opposite corners are `from` and `to`. Marks stay geometry until
 * the run is sent, which is what keeps them editable.
 */
export interface Annotation {
  readonly tool: AnnotationTool;
  readonly from: Point;
  readonly to: Point;
}

/** Either end of a mark, dragged to re-aim an arrow or resize a circle. */
export type Handle = 'from' | 'to';

export type ImageSize = Readonly<Pick<Screenshot, 'width' | 'height'>>;

/** Where the preview canvas is laid out on screen (`getBoundingClientRect()`), in CSS pixels. */
export interface DisplayBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Ellipse {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

/** Straight segments approximating a circle's outline when hit testing it. */
const OUTLINE_SEGMENTS = 48;
/** Angle between an arrow's shaft and each barb of its head. */
const HEAD_SPREAD = Math.PI / 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Converts a pointer position over the preview (client CSS pixels) into
 * capture pixels. The preview is scaled to fit the panel — shrunk on a
 * narrow panel, possibly stretched on a wide one — so each axis is rescaled
 * by image size over displayed size, then clamped so a drag that leaves the
 * canvas still lands on its edge.
 */
export function toImagePoint(client: Point, box: DisplayBox, image: ImageSize): Point {
  return {
    x: clamp(((client.x - box.left) * image.width) / box.width, 0, image.width),
    y: clamp(((client.y - box.top) * image.height) / box.height, 0, image.height),
  };
}

/**
 * Stroke width in capture pixels, proportional to the capture's longest side
 * (captures are at most 800 px, see `computeTargetSize`) so marks read the
 * same on a small button as on a whole card.
 */
export function strokeWidthFor(image: ImageSize): number {
  return Math.max(2, Math.round(Math.max(image.width, image.height) / 160));
}

/** Whether a drag spans enough of the capture (two stroke widths) to be a mark rather than a stray click. */
export function isMark(mark: Annotation, image: ImageSize): boolean {
  const span = Math.max(Math.abs(mark.to.x - mark.from.x), Math.abs(mark.to.y - mark.from.y));
  return span >= strokeWidthFor(image) * 2;
}

/** The ellipse a circle mark draws: inscribed in the box its two ends span. */
export function ellipseOf(mark: Annotation): Ellipse {
  return {
    cx: (mark.from.x + mark.to.x) / 2,
    cy: (mark.from.y + mark.to.y) / 2,
    rx: Math.abs(mark.to.x - mark.from.x) / 2,
    ry: Math.abs(mark.to.y - mark.from.y) / 2,
  };
}

/**
 * The two barb ends of an arrow's head, which points at `mark.to`: each sits
 * back along the shaft, 30° off it. The head grows with the stroke and
 * shrinks on arrows too short to carry a full one.
 */
export function arrowHeadOf(mark: Annotation, lineWidth: number): readonly [Point, Point] {
  const dx = mark.to.x - mark.from.x;
  const dy = mark.to.y - mark.from.y;
  const length = Math.min(lineWidth * 4 + 4, Math.hypot(dx, dy) / 2);
  const angle = Math.atan2(dy, dx);
  const barb = (side: number): Point => ({
    x: mark.to.x - length * Math.cos(angle + side * HEAD_SPREAD),
    y: mark.to.y - length * Math.sin(angle + side * HEAD_SPREAD),
  });
  return [barb(-1), barb(1)];
}

function badgeAnchor(mark: Annotation, radius: number): Point {
  switch (mark.tool) {
    case 'arrow': {
      const dx = mark.to.x - mark.from.x;
      const dy = mark.to.y - mark.from.y;
      // A mark still being drawn can be a single point: no direction yet.
      const length = Math.hypot(dx, dy) || 1;
      return { x: mark.from.x - (dx / length) * radius, y: mark.from.y - (dy / length) * radius };
    }
    case 'circle': {
      const { cx, cy, rx, ry } = ellipseOf(mark);
      return { x: cx - rx * Math.SQRT1_2, y: cy - ry * Math.SQRT1_2 };
    }
  }
}

/**
 * Where the number badge (of `radius`) of a mark goes: just behind an
 * arrow's tail, so the head stays clear to point at the target; on a
 * circle's upper-left outline. Always whole inside the capture.
 */
export function badgeCenterOf(mark: Annotation, radius: number, image: ImageSize): Point {
  const anchor = badgeAnchor(mark, radius);
  return {
    x: clamp(anchor.x, radius, image.width - radius),
    y: clamp(anchor.y, radius, image.height - radius),
  };
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function distanceToOutline(point: Point, { cx, cy, rx, ry }: Ellipse): number {
  let nearest = Infinity;
  let previous: Point = { x: cx + rx, y: cy };
  for (let step = 1; step <= OUTLINE_SEGMENTS; step += 1) {
    const angle = (step / OUTLINE_SEGMENTS) * 2 * Math.PI;
    const next: Point = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
    nearest = Math.min(nearest, distanceToSegment(point, previous, next));
    previous = next;
  }
  return nearest;
}

/** Distance from `point` to the stroke of `mark`: an arrow's shaft, a circle's outline (not its inside). */
function distanceToMark(mark: Annotation, point: Point): number {
  switch (mark.tool) {
    case 'arrow':
      return distanceToSegment(point, mark.from, mark.to);
    case 'circle':
      return distanceToOutline(point, ellipseOf(mark));
  }
}

/**
 * The topmost mark (the most recently drawn) whose stroke passes within
 * `tolerance` capture pixels of `point`. A circle is only grabbed by its
 * outline, so a press inside it still starts a new mark — an arrow into the
 * circled area, say.
 */
export function hitTestMarks(
  marks: readonly Annotation[],
  point: Point,
  tolerance: number,
): { readonly index: number; readonly mark: Annotation } | null {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index];
    if (mark && distanceToMark(mark, point) <= tolerance) return { index, mark };
  }
  return null;
}

/** Which end of `mark` lies within `tolerance` capture pixels of `point`; the head wins a tie, it is what gets re-aimed. */
export function handleAt(mark: Annotation, point: Point, tolerance: number): Handle | null {
  if (Math.hypot(point.x - mark.to.x, point.y - mark.to.y) <= tolerance) return 'to';
  if (Math.hypot(point.x - mark.from.x, point.y - mark.from.y) <= tolerance) return 'from';
  return null;
}

/** `mark` shifted by `delta`, stopping at the capture's edges so the whole mark stays inside it. */
export function moveMark(mark: Annotation, delta: Point, image: ImageSize): Annotation {
  const dx = clamp(delta.x, -Math.min(mark.from.x, mark.to.x), image.width - Math.max(mark.from.x, mark.to.x));
  const dy = clamp(delta.y, -Math.min(mark.from.y, mark.to.y), image.height - Math.max(mark.from.y, mark.to.y));
  return {
    tool: mark.tool,
    from: { x: mark.from.x + dx, y: mark.from.y + dy },
    to: { x: mark.to.x + dx, y: mark.to.y + dy },
  };
}

/** `mark` with one end dragged to `point`. */
export function reshapeMark(mark: Annotation, handle: Handle, point: Point): Annotation {
  return { ...mark, [handle]: point };
}
