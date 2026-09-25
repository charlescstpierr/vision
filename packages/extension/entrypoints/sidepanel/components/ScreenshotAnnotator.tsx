import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { Screenshot } from '@vizion/shared';
import {
  handleAt,
  hitTestMarks,
  strokeWidthFor,
  toImagePoint,
  type Annotation,
  type AnnotationTool,
  type Handle,
  type Point,
} from '../../../utils/annotations.js';
import { paintCapture, paintHandles } from '../../../utils/annotation-render.js';
import type { HistoryState } from '../../../utils/edit-history.js';
import { useCaptureBitmap } from '../hooks/useCaptureBitmap.js';
import { editFor, follow, marksDuring, type Gesture } from '../state/gestures.js';
import type { AnnotationAction } from '../state/runState.js';

type Props = {
  /** The staged capture: not sent yet, so its marks can still change. */
  screenshot: Screenshot;
  annotations: HistoryState<Annotation>;
  onAnnotate: (action: AnnotationAction) => void;
  /** Drops the staged capture altogether ("Retirer"). */
  onRemove: () => void;
};

type Hover = 'none' | 'mark' | 'handle';

const TOOLS: readonly { id: AnnotationTool; label: string }[] = [
  { id: 'arrow', label: 'Flèche' },
  { id: 'circle', label: 'Cercle' },
];

/** How close (CSS px) a press must land to a mark's stroke to grab the mark. */
const GRAB_SLOP_PX = 6;
/** Radius (CSS px) of the handles drawn on the selected mark's ends. */
const HANDLE_RADIUS_PX = 5;

const GESTURE_CURSOR: Record<Gesture['kind'], string> = { draw: 'crosshair', move: 'grabbing', reshape: 'grabbing' };
const HOVER_CURSOR: Record<Hover, string> = { none: 'crosshair', mark: 'move', handle: 'grab' };

const panelStyle: CSSProperties = { marginTop: 8, border: '1px solid #ddd', borderRadius: 8, padding: 10 };
const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#666' };
const canvasStyle: CSSProperties = {
  display: 'block',
  width: 'auto',
  height: 'auto',
  maxWidth: '100%',
  maxHeight: 360,
  marginTop: 8,
  // A ring, not a border: a border would offset the drawing area from
  // getBoundingClientRect() and skew the pointer mapping.
  boxShadow: '0 0 0 1px #ddd',
  touchAction: 'none',
};

/**
 * Editor for the staged capture: draw arrows and circles on it, click a mark
 * to move it or drag its ends, delete it, undo, clear. Marks stay editable
 * geometry until the run is explicitly sent, and the preview paints them
 * with the very code that flattens them into the image sent to the agent.
 */
export default function ScreenshotAnnotator({ screenshot, annotations, onAnnotate, onRemove }: Props) {
  const toolGroup = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capture = useCaptureBitmap(screenshot.dataUrl);
  const [tool, setTool] = useState<AnnotationTool>('arrow');
  const [selected, setSelected] = useState<number | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<Hover>('none');

  const { width, height } = screenshot;
  const size = useMemo(() => ({ width, height }), [width, height]);
  const marks = annotations.present;
  const shown = useMemo(() => marksDuring(marks, gesture), [marks, gesture]);
  const selectedMark = selected === null ? undefined : marks[selected];
  const handlesOn = gesture?.mark ?? selectedMark;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || capture.status !== 'ready') return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintCapture(ctx, { image: capture.bitmap, ...size }, shown);
    if (handlesOn) {
      paintHandles(ctx, handlesOn, (HANDLE_RADIUS_PX * canvas.width) / canvas.getBoundingClientRect().width);
    }
  }, [capture, size, shown, handlesOn]);

  /** The pointer in capture pixels, and how many capture pixels one CSS pixel spans at the preview's current size. */
  const locate = (event: PointerEvent<HTMLCanvasElement>): { point: Point; scale: number } => {
    const box = event.currentTarget.getBoundingClientRect();
    return { point: toImagePoint({ x: event.clientX, y: event.clientY }, box, size), scale: size.width / box.width };
  };
  const handleUnder = (point: Point, scale: number): Handle | null =>
    selectedMark ? handleAt(selectedMark, point, (HANDLE_RADIUS_PX + 2) * scale) : null;
  const markUnder = (point: Point, scale: number) =>
    hitTestMarks(marks, point, GRAB_SLOP_PX * scale + strokeWidthFor(size) / 2);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (gesture !== null || event.button !== 0) return;
    const { point, scale } = locate(event);
    const { pointerId } = event;
    event.currentTarget.setPointerCapture(pointerId);
    const handle = handleUnder(point, scale);
    if (handle && selectedMark && selected !== null) {
      setGesture({ kind: 'reshape', pointerId, index: selected, handle, original: selectedMark, mark: selectedMark });
      return;
    }
    const hit = markUnder(point, scale);
    if (hit) {
      setSelected(hit.index);
      setGesture({ kind: 'move', pointerId, index: hit.index, grab: point, original: hit.mark, mark: hit.mark });
      return;
    }
    setSelected(null);
    setGesture({ kind: 'draw', pointerId, mark: { tool, from: point, to: point } });
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const { point, scale } = locate(event);
    if (gesture === null) {
      setHover(handleUnder(point, scale) ? 'handle' : markUnder(point, scale) ? 'mark' : 'none');
    } else if (event.pointerId === gesture.pointerId) {
      setGesture(follow(gesture, point, size));
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (gesture === null || event.pointerId !== gesture.pointerId) return;
    const edit = editFor(follow(gesture, locate(event).point, size), size);
    setGesture(null);
    if (!edit) return;
    onAnnotate(edit);
    // A new mark comes up selected, so it can be adjusted right away.
    if (edit.type === 'add-annotation') setSelected(marks.length);
  };

  const cancelGesture = () => setGesture(null);

  const removeSelected = () => {
    if (selected === null || !selectedMark) return;
    onAnnotate({ type: 'remove-annotation', index: selected });
    setSelected(null);
  };
  const undoLast = () => {
    onAnnotate({ type: 'undo-annotation' });
    setSelected(null);
  };
  const clearAll = () => {
    onAnnotate({ type: 'clear-annotations' });
    setSelected(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === 'Escape') {
      setGesture(null);
      setSelected(null);
      return;
    }
    if (gesture !== null) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeSelected();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoLast();
    }
  };

  const hint =
    marks.length === 0
      ? 'Glisse sur la capture pour pointer la cible : flèche ou cercle.'
      : 'Clique une marque pour la déplacer ou tirer ses extrémités ; cite son numéro dans le prompt.';

  return (
    <section aria-label="Capture à envoyer" style={panelStyle}>
      <div style={rowStyle}>
        <strong style={{ fontSize: 13 }}>Capture à envoyer</strong>
        <span style={mutedStyle}>
          {width}×{height}px · pas encore envoyée
        </span>
      </div>

      <div style={{ ...rowStyle, flexWrap: 'wrap', marginTop: 8 }}>
        <div role="radiogroup" aria-label="Outil" style={{ display: 'flex', gap: 10 }}>
          {TOOLS.map(({ id, label }) => (
            <label key={id} style={{ fontSize: 12, color: '#444', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="radio" name={toolGroup} checked={tool === id} onChange={() => setTool(id)} />
              {label}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            style={{ fontSize: 12 }}
            disabled={!selectedMark}
            onClick={removeSelected}
            title="Supprimer la marque sélectionnée (Suppr)"
          >
            Supprimer
          </button>
          <button
            type="button"
            style={{ fontSize: 12 }}
            disabled={annotations.past.length === 0}
            onClick={undoLast}
            title="Annuler la dernière modification (Ctrl+Z)"
          >
            Annuler ({annotations.past.length})
          </button>
          <button
            type="button"
            style={{ fontSize: 12 }}
            disabled={marks.length === 0}
            onClick={clearAll}
            title="Effacer toutes les marques"
          >
            Tout effacer
          </button>
        </div>
      </div>

      {capture.status === 'error' ? (
        <p style={{ fontSize: 12, color: '#a83232', marginTop: 8 }}>Aperçu indisponible : {capture.message}</p>
      ) : (
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          tabIndex={0}
          role="application"
          aria-label="Capture : glisse pour tracer une marque, clique une marque pour l'ajuster, Suppr pour l'effacer"
          style={{ ...canvasStyle, cursor: gesture ? GESTURE_CURSOR[gesture.kind] : HOVER_CURSOR[hover] }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={cancelGesture}
          onPointerLeave={() => setHover('none')}
          onKeyDown={onKeyDown}
        />
      )}

      <div style={{ ...rowStyle, alignItems: 'baseline', marginTop: 6 }}>
        <span aria-live="polite" style={mutedStyle}>
          {hint}
        </span>
        <a
          href="#"
          style={{ fontSize: 11, flex: '0 0 auto' }}
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
        >
          Retirer
        </a>
      </div>
    </section>
  );
}
