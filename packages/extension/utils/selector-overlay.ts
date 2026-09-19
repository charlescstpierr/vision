import type { ContentToPanelMessage, PanelToContentMessage, RectReply } from '@vizion/shared';
import { extractElementContext } from './dom.js';
import { InlineEditor } from './inline-editor.js';

const HIGHLIGHT_COLOR = '#2f6bff';

type Rect = { x: number; y: number; width: number; height: number };

function unionRect(elements: Element[]): Rect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Clips a viewport-relative rect to the visible viewport; `null` if nothing is left. */
function clipToViewport(rect: Rect): Rect | null {
  const left = Math.max(rect.x, 0);
  const top = Math.max(rect.y, 0);
  const right = Math.min(rect.x + rect.width, window.innerWidth);
  const bottom = Math.min(rect.y + rect.height, window.innerHeight);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Owns the hover-highlight overlay + selection lifecycle for the content
 * script. Created lazily and attached to <html> so it survives a full body
 * replacement (SPA navigations, React re-mounts, etc).
 */
export class SelectorOverlay {
  private enabled = false;
  private box: HTMLDivElement | undefined;
  private label: HTMLDivElement | undefined;
  private currentTarget: Element | undefined;
  private inlineEditor = new InlineEditor();

  constructor() {
    chrome.runtime.onMessage.addListener(
      (message: PanelToContentMessage, _sender, sendResponse) => {
        if (message.type === 'vizion:set-select-mode') {
          this.setEnabled(message.enabled);
          sendResponse(undefined);
          return false;
        }
        if (message.type === 'vizion:get-state') {
          sendResponse({ enabled: this.enabled });
          return false;
        }
        if (message.type === 'vizion:edit-text') {
          this.inlineEditor.start(message.selector);
          sendResponse(undefined);
          return false;
        }
        if (message.type === 'vizion:get-rect') {
          void this.getRect(message.selectors).then(sendResponse);
          return true;
        }
        return false;
      },
    );
  }

  /**
   * Computes the union bounding box (viewport CSS pixels) of the given
   * selectors, clipped to the viewport. If nothing is visible, scrolls the
   * first matching element into view and remeasures after a frame. The
   * overlay/label are hidden first so they're never captured.
   */
  private async getRect(selectors: string[]): Promise<RectReply> {
    const devicePixelRatio = window.devicePixelRatio;
    const elements = selectors
      .map((selector) => {
        try {
          return document.querySelector(selector);
        } catch {
          return null;
        }
      })
      .filter((el): el is Element => el !== null);

    if (elements.length === 0) {
      return { rect: null, devicePixelRatio };
    }

    this.hideOverlay();

    let rect = clipToViewport(unionRect(elements));
    if (!rect) {
      elements[0]!.scrollIntoView({ block: 'center' });
      await nextAnimationFrame();
      rect = clipToViewport(unionRect(elements));
    }

    return { rect, devicePixelRatio };
  }

  private ensureOverlay(): { box: HTMLDivElement; label: HTMLDivElement } {
    if (this.box && this.label) {
      return { box: this.box, label: this.label };
    }

    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.pointerEvents = 'none';
    box.style.zIndex = '2147483647';
    box.style.outline = `2px solid ${HIGHLIGHT_COLOR}`;
    box.style.backgroundColor = 'rgba(47, 107, 255, 0.12)';
    box.style.boxSizing = 'border-box';
    box.style.display = 'none';
    box.style.top = '0';
    box.style.left = '0';

    const label = document.createElement('div');
    label.style.position = 'fixed';
    label.style.pointerEvents = 'none';
    label.style.zIndex = '2147483647';
    label.style.background = HIGHLIGHT_COLOR;
    label.style.color = '#fff';
    label.style.font = '11px/1.4 monospace';
    label.style.padding = '1px 4px';
    label.style.borderRadius = '2px';
    label.style.display = 'none';
    label.style.whiteSpace = 'pre-line';

    document.documentElement.appendChild(box);
    document.documentElement.appendChild(label);
    this.box = box;
    this.label = label;
    return { box, label };
  }

  private isOwnElement(el: Element | null): boolean {
    return el === this.box || el === this.label;
  }

  private highlight(el: Element): void {
    const { box, label } = this.ensureOverlay();
    const rect = el.getBoundingClientRect();

    box.style.display = 'block';
    box.style.top = `${rect.top}px`;
    box.style.left = `${rect.left}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;

    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const firstClass = el.classList.length > 0 ? `.${el.classList[0]}` : '';
    // `highlight` only ever runs while select mode is on, so the multi-select
    // hint always applies here.
    label.textContent = `${tag}${id}${firstClass}\nMaj+clic pour ajouter`;
    label.style.display = 'block';
    const labelTop = rect.top > 16 ? rect.top - 18 : rect.bottom + 2;
    label.style.top = `${labelTop}px`;
    label.style.left = `${rect.left}px`;
  }

  private hideOverlay(): void {
    if (this.box) this.box.style.display = 'none';
    if (this.label) this.label.style.display = 'none';
    this.currentTarget = undefined;
  }

  private handleMouseMove = (event: MouseEvent): void => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || this.isOwnElement(target)) return;
    if (target === this.currentTarget) return;
    this.currentTarget = target;
    this.highlight(target);
  };

  private handleClick = (event: MouseEvent): void => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || this.isOwnElement(target)) return;

    event.preventDefault();
    event.stopPropagation();

    // Shift+click adds to the current selection and stays in select mode so
    // more elements can be picked; a plain click replaces the selection and
    // exits, as before.
    const append = event.shiftKey;
    const context = extractElementContext(target, window.location.href);
    const message: ContentToPanelMessage = { type: 'vizion:element-selected', element: context, append };
    chrome.runtime.sendMessage(message).catch(() => {
      /* panel may be closed; ignore */
    });

    if (!append) {
      this.setEnabled(false);
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.setEnabled(false);
    }
  };

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;

    if (enabled) {
      document.addEventListener('mousemove', this.handleMouseMove, true);
      document.addEventListener('click', this.handleClick, true);
      document.addEventListener('keydown', this.handleKeyDown, true);
      document.documentElement.style.cursor = 'crosshair';
    } else {
      document.removeEventListener('mousemove', this.handleMouseMove, true);
      document.removeEventListener('click', this.handleClick, true);
      document.removeEventListener('keydown', this.handleKeyDown, true);
      document.documentElement.style.cursor = '';
      this.hideOverlay();
    }

    const message: ContentToPanelMessage = { type: 'vizion:select-mode-changed', enabled };
    chrome.runtime.sendMessage(message).catch(() => {
      /* panel may be closed; ignore */
    });
  }
}
