import type { ElementContext } from './index.js';

export type PanelToContentMessage =
  | { type: 'vizion:set-select-mode'; enabled: boolean }
  | { type: 'vizion:get-state' };

export type ContentToPanelMessage =
  | { type: 'vizion:element-selected'; element: ElementContext }
  | { type: 'vizion:select-mode-changed'; enabled: boolean };
