import type { ContentToPanelMessage, PanelToContentMessage } from '@vizion/shared';
import { extractElementContext } from './dom.js';

const HIGHLIGHT_COLOR = '#2f6bff';

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
        return false;
      },
    );
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
    label.style.whiteSpace = 'nowrap';

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
    label.textContent = `${tag}${id}${firstClass}`;
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

    const context = extractElementContext(target, window.location.href);
    const message: ContentToPanelMessage = { type: 'vizion:element-selected', element: context };
    chrome.runtime.sendMessage(message).catch(() => {
      /* panel may be closed; ignore */
    });

    this.setEnabled(false);
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
