import type { ElementContext } from './index.js';

export type PanelToContentMessage =
  | { type: 'vizion:set-select-mode'; enabled: boolean }
  | { type: 'vizion:get-state' }
  | { type: 'vizion:edit-text'; selector: string }
  | { type: 'vizion:get-rect'; selectors: string[] };

export type ContentToPanelMessage =
  | { type: 'vizion:element-selected'; element: ElementContext; append?: boolean }
  | { type: 'vizion:select-mode-changed'; enabled: boolean }
  | { type: 'vizion:text-edited'; selector: string; before: string; after: string; committed: boolean };

/** Reply to `vizion:get-rect`: the union bounding box of the selectors in CSS pixels, viewport-relative. */
export interface RectReply {
  rect: { x: number; y: number; width: number; height: number } | null;
  devicePixelRatio: number;
}
