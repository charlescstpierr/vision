import {
  isMark,
  moveMark,
  reshapeMark,
  type Annotation,
  type Handle,
  type ImageSize,
  type Point,
} from '../../../utils/annotations.js';
import type { AnnotationAction } from './runState.js';

/**
 * A drag in progress on the capture preview — drawing a new mark, moving
 * one, or dragging one of its ends — with `mark` its live geometry.
 */
export type Gesture =
  | { kind: 'draw'; pointerId: number; mark: Annotation }
  | { kind: 'move'; pointerId: number; index: number; grab: Point; original: Annotation; mark: Annotation }
  | { kind: 'reshape'; pointerId: number; index: number; handle: Handle; original: Annotation; mark: Annotation };

/** The gesture once the pointer is at `point` (capture pixels). */
export function follow(gesture: Gesture, point: Point, size: ImageSize): Gesture {
  switch (gesture.kind) {
    case 'draw':
      return { ...gesture, mark: { ...gesture.mark, to: point } };
    case 'move': {
      const delta = { x: point.x - gesture.grab.x, y: point.y - gesture.grab.y };
      return { ...gesture, mark: moveMark(gesture.original, delta, size) };
    }
    case 'reshape':
      return { ...gesture, mark: reshapeMark(gesture.original, gesture.handle, point) };
  }
}

function sameGeometry(a: Annotation, b: Annotation): boolean {
  return a.from.x === b.from.x && a.from.y === b.from.y && a.to.x === b.to.x && a.to.y === b.to.y;
}

/**
 * The edit a finished gesture makes, if any. None for a stray click, a move
 * that went nowhere or an end dropped onto the other one, so such gestures
 * never add an undo step.
 */
export function editFor(gesture: Gesture, size: ImageSize): AnnotationAction | null {
  if (!isMark(gesture.mark, size)) return null;
  switch (gesture.kind) {
    case 'draw':
      return { type: 'add-annotation', annotation: gesture.mark };
    case 'move':
    case 'reshape':
      return sameGeometry(gesture.mark, gesture.original)
        ? null
        : { type: 'update-annotation', index: gesture.index, annotation: gesture.mark };
  }
}

/** The marks as they look mid-gesture: the one being drawn added, or the one being dragged where it is now. */
export function marksDuring(marks: readonly Annotation[], gesture: Gesture | null): readonly Annotation[] {
  if (gesture === null) return marks;
  switch (gesture.kind) {
    case 'draw':
      return [...marks, gesture.mark];
    case 'move':
    case 'reshape':
      return marks.map((mark, index) => (index === gesture.index ? gesture.mark : mark));
  }
}
