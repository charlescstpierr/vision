import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../../utils/annotations.js';
import { editFor, follow, type Gesture } from './gestures.js';

const SIZE = { width: 400, height: 200 };
const ARROW: Annotation = { tool: 'arrow', from: { x: 40, y: 150 }, to: { x: 200, y: 60 } };

describe('editFor', () => {
  it('adds a mark once a draw is released after a real drag', () => {
    const draw: Gesture = { kind: 'draw', pointerId: 1, mark: { tool: 'circle', from: { x: 50, y: 50 }, to: { x: 50, y: 50 } } };
    const released = follow(draw, { x: 150, y: 120 }, SIZE);
    expect(editFor(released, SIZE)).toEqual({
      type: 'add-annotation',
      annotation: { tool: 'circle', from: { x: 50, y: 50 }, to: { x: 150, y: 120 } },
    });
  });

  it('adds nothing for a click that did not drag', () => {
    const draw: Gesture = { kind: 'draw', pointerId: 1, mark: { tool: 'arrow', from: { x: 50, y: 50 }, to: { x: 50, y: 50 } } };
    expect(editFor(follow(draw, { x: 51, y: 50 }, SIZE), SIZE)).toBeNull();
  });

  it('moves a grabbed mark by how far the pointer travelled', () => {
    const move: Gesture = { kind: 'move', pointerId: 1, index: 2, grab: { x: 100, y: 100 }, original: ARROW, mark: ARROW };
    expect(editFor(follow(move, { x: 110, y: 90 }, SIZE), SIZE)).toEqual({
      type: 'update-annotation',
      index: 2,
      annotation: { tool: 'arrow', from: { x: 50, y: 140 }, to: { x: 210, y: 50 } },
    });
  });

  it('records no edit when a grabbed mark is dropped where it was, so selecting adds no undo step', () => {
    const move: Gesture = { kind: 'move', pointerId: 1, index: 0, grab: { x: 100, y: 100 }, original: ARROW, mark: ARROW };
    expect(editFor(follow(move, { x: 100, y: 100 }, SIZE), SIZE)).toBeNull();
  });

  it('drops a reshape that collapses an arrow onto its own tail', () => {
    const reshape: Gesture = { kind: 'reshape', pointerId: 1, index: 0, handle: 'to', original: ARROW, mark: ARROW };
    expect(editFor(follow(reshape, ARROW.from, SIZE), SIZE)).toBeNull();
  });
});
