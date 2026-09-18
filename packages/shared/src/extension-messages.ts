import type { ElementContext } from './index.js';

export type PanelToContentMessage =
  | { type: 'vizion:set-select-mode'; enabled: boolean }
  | { type: 'vizion:get-state' }
  | { type: 'vizion:edit-text'; selector: string };

export type ContentToPanelMessage =
  | { type: 'vizion:element-selected'; element: ElementContext }
  | { type: 'vizion:select-mode-changed'; enabled: boolean }
  | { type: 'vizion:text-edited'; selector: string; before: string; after: string; committed: boolean };
