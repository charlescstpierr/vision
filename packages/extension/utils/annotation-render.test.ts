import { describe, expect, it } from 'vitest';
import type { Screenshot } from '@vizion/shared';
import type { Annotation } from './annotations.js';
import {
  encodeAnnotatedCapture,
  renderAnnotatedScreenshot,
  type ExportCanvas,
  type PaintContext,
} from './annotation-render.js';

type Op = { op: string; args: unknown[] };
type Recording = { type: string; width: number; height: number; ops: Op[] };

const JPEG_PREFIX = 'data:image/jpeg;base64,';

/**
 * Stand-in for a browser canvas, which happy-dom does not provide: records
 * every draw call and "encodes" the recording, so the returned bytes are a
 * function of exactly what was painted, at what size, in which format.
 */
function recordingCanvas(): ExportCanvas {
  const ops: Op[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      ops.push({ op, args: args.map((arg) => (typeof arg === 'object' && arg !== null ? '[image]' : arg)) });
    };
  const context: PaintContext = {
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    ellipse: record('ellipse'),
    arc: record('arc'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillText: record('fillText'),
    strokeRect: record('strokeRect'),
    setLineDash: record('setLineDash'),
    strokeStyle: '#000000',
    fillStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  const canvas: ExportCanvas = {
    // A fresh browser canvas is 300×150 until resized.
    width: 300,
    height: 150,
    getContext: () => context,
    toDataURL: (type) => {
      const recording: Recording = { type, width: canvas.width, height: canvas.height, ops };
      return `data:${type};base64,${btoa(JSON.stringify(recording))}`;
    },
  };
  return canvas;
}

function decodeRecording(dataUrl: string): Recording {
  const recording: Recording = JSON.parse(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)));
  return recording;
}

const STAGED: Screenshot = { dataUrl: `${JPEG_PREFIX}c3RhZ2Vk`, width: 240, height: 120 };
// Ellipse centred on (80, 40) with radii 40 × 20.
const CIRCLE: Annotation = { tool: 'circle', from: { x: 40, y: 20 }, to: { x: 120, y: 60 } };
const ARROW: Annotation = { tool: 'arrow', from: { x: 200, y: 100 }, to: { x: 150, y: 50 } };

function capture() {
  return { image: document.createElement('canvas'), width: STAGED.width, height: STAGED.height };
}

describe('renderAnnotatedScreenshot', () => {
  it('sends the staged capture untouched when nothing is drawn on it', async () => {
    await expect(renderAnnotatedScreenshot(STAGED, [])).resolves.toEqual(STAGED);
  });
});

describe('encodeAnnotatedCapture', () => {
  it('encodes a JPEG exactly the size of the capture, whatever size the canvas had', () => {
    const shot = encodeAnnotatedCapture(recordingCanvas(), capture(), [CIRCLE]);

    expect(shot.dataUrl.startsWith(JPEG_PREFIX)).toBe(true);
    expect({ width: shot.width, height: shot.height }).toEqual({ width: 240, height: 120 });
    const encoded = decodeRecording(shot.dataUrl);
    expect({ width: encoded.width, height: encoded.height }).toEqual({ width: 240, height: 120 });
  });

  it('paints the capture at full size first, then every mark on top of it in image pixels', () => {
    const { ops } = decodeRecording(encodeAnnotatedCapture(recordingCanvas(), capture(), [CIRCLE, ARROW]).dataUrl);

    const image = ops.findIndex((o) => o.op === 'drawImage');
    expect(ops[image]?.args).toEqual(['[image]', 0, 0, 240, 120]);
    const circle = ops.findIndex((o) => o.op === 'ellipse' && o.args.slice(0, 4).join() === '80,40,40,20');
    const arrowTip = ops.findIndex((o) => o.op === 'lineTo' && o.args.join() === '150,50');
    const firstStroke = ops.findIndex((o) => o.op === 'stroke');
    expect(circle).toBeGreaterThan(image);
    expect(arrowTip).toBeGreaterThan(image);
    expect(firstStroke).toBeGreaterThan(image);
  });

  it('numbers the marks in the order they were drawn', () => {
    const { ops } = decodeRecording(encodeAnnotatedCapture(recordingCanvas(), capture(), [CIRCLE, ARROW]).dataUrl);

    expect(ops.filter((o) => o.op === 'fillText').map((o) => o.args[0])).toEqual(['1', '2']);
  });

  it('encodes different bytes once a mark is taken back', () => {
    const both = encodeAnnotatedCapture(recordingCanvas(), capture(), [CIRCLE, ARROW]);
    const one = encodeAnnotatedCapture(recordingCanvas(), capture(), [CIRCLE]);

    expect(one.dataUrl).not.toBe(both.dataUrl);
  });
});
