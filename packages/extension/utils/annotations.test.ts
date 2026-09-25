import { describe, expect, it } from 'vitest';
import { handleAt, hitTestMarks, isMark, moveMark, toImagePoint, type Annotation } from './annotations.js';

describe('toImagePoint', () => {
  const narrowBox = { left: 10, top: 20, width: 200, height: 50 };

  it('scales a pointer on a narrow panel up to image pixels', () => {
    // An 800×200 capture shown 200 CSS px wide: one CSS px covers 4 image px.
    expect(toImagePoint({ x: 60, y: 45 }, narrowBox, { width: 800, height: 200 })).toEqual({ x: 200, y: 100 });
  });

  it('scales a pointer on a wide panel down to image pixels', () => {
    // A 400×100 capture stretched to 600 CSS px: one CSS px covers 2/3 image px.
    const wideBox = { left: 10, top: 20, width: 600, height: 150 };
    expect(toImagePoint({ x: 310, y: 95 }, wideBox, { width: 400, height: 100 })).toEqual({ x: 200, y: 50 });
  });

  it('clamps a pointer dragged past the preview onto the image edge', () => {
    expect(toImagePoint({ x: -40, y: 500 }, narrowBox, { width: 800, height: 200 })).toEqual({ x: 0, y: 200 });
  });
});

describe('isMark', () => {
  const image = { width: 800, height: 400 };

  it('does not treat a click that barely moved as a mark', () => {
    expect(isMark({ tool: 'arrow', from: { x: 100, y: 100 }, to: { x: 101, y: 100 } }, image)).toBe(false);
  });

  it('treats a real drag as a mark', () => {
    expect(isMark({ tool: 'circle', from: { x: 100, y: 100 }, to: { x: 300, y: 200 } }, image)).toBe(true);
  });
});

describe('hitTestMarks', () => {
  const arrow: Annotation = { tool: 'arrow', from: { x: 20, y: 20 }, to: { x: 120, y: 20 } };
  // The ellipse centred on (250, 130) with radii 50 × 30.
  const circle: Annotation = { tool: 'circle', from: { x: 200, y: 100 }, to: { x: 300, y: 160 } };

  it('grabs an arrow pressed next to its shaft', () => {
    expect(hitTestMarks([arrow, circle], { x: 70, y: 24 }, 6)).toEqual({ index: 0, mark: arrow });
  });

  it('grabs a circle pressed on its outline', () => {
    expect(hitTestMarks([arrow, circle], { x: 302, y: 130 }, 6)).toEqual({ index: 1, mark: circle });
  });

  it('lets a press inside a circle start a new mark instead of grabbing the circle', () => {
    expect(hitTestMarks([arrow, circle], { x: 250, y: 130 }, 6)).toBeNull();
  });

  it('grabs the most recently drawn mark where two overlap', () => {
    const crossing: Annotation = { tool: 'arrow', from: { x: 70, y: 0 }, to: { x: 70, y: 60 } };
    expect(hitTestMarks([arrow, crossing], { x: 70, y: 20 }, 6)?.index).toBe(1);
  });
});

describe('handleAt', () => {
  const arrow: Annotation = { tool: 'arrow', from: { x: 20, y: 20 }, to: { x: 120, y: 80 } };

  it('finds the end under the pointer', () => {
    expect(handleAt(arrow, { x: 118, y: 83 }, 5)).toBe('to');
    expect(handleAt(arrow, { x: 22, y: 18 }, 5)).toBe('from');
  });

  it('finds no handle away from both ends', () => {
    expect(handleAt(arrow, { x: 70, y: 50 }, 5)).toBeNull();
  });
});

describe('moveMark', () => {
  const image = { width: 200, height: 100 };
  const circle: Annotation = { tool: 'circle', from: { x: 30, y: 20 }, to: { x: 80, y: 60 } };

  it('moves both ends of a mark by the drag', () => {
    expect(moveMark(circle, { x: 15, y: -5 }, image)).toEqual({
      tool: 'circle',
      from: { x: 45, y: 15 },
      to: { x: 95, y: 55 },
    });
  });

  it('stops at the image edge instead of pushing the mark out of the capture', () => {
    expect(moveMark(circle, { x: -50, y: 70 }, image)).toEqual({
      tool: 'circle',
      from: { x: 0, y: 60 },
      to: { x: 50, y: 100 },
    });
  });
});
