import type { ContentToPanelMessage } from '@vizion/shared';

const OUTLINE_COLOR = '#2f6bff';

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function selectAllText(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Owns the double-click-to-edit / `vizion:edit-text` inline text editing
 * lifecycle: makes an element `contentEditable`, focuses + selects it, and
 * reports the outcome back to the side panel. Only one element is edited at
 * a time; starting a new edit cancels whatever was in progress.
 */
export class InlineEditor {
  private target: HTMLElement | undefined;
  private selector = '';
  private originalText = '';
  private previousOutline = '';

  /** Starts (or restarts) editing the element matching `selector`. */
  start(selector: string): void {
    this.cancel();

    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) {
      this.send({
        type: 'vizion:text-edited',
        selector,
        before: '',
        after: '',
        committed: false,
      });
      return;
    }

    this.target = el;
    this.selector = selector;
    this.originalText = el.textContent ?? '';
    this.previousOutline = el.style.outline;

    el.contentEditable = 'true';
    el.style.outline = `2px dashed ${OUTLINE_COLOR}`;
    el.addEventListener('keydown', this.handleKeyDown);
    el.addEventListener('blur', this.handleBlur);

    el.focus();
    selectAllText(el);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.finish(false);
    }
  };

  private handleBlur = (): void => {
    this.finish(true);
  };

  private finish(fromCommitOrBlur: boolean): void {
    const el = this.target;
    if (!el) return;
    this.target = undefined;

    const before = collapse(this.originalText);
    const after = fromCommitOrBlur ? collapse(el.textContent ?? '') : before;
    if (!fromCommitOrBlur) {
      el.textContent = this.originalText;
    }

    el.removeEventListener('keydown', this.handleKeyDown);
    el.removeEventListener('blur', this.handleBlur);
    el.removeAttribute('contenteditable');
    el.style.outline = this.previousOutline;

    this.send({
      type: 'vizion:text-edited',
      selector: this.selector,
      before,
      after,
      committed: fromCommitOrBlur && after !== before,
    });
  }

  /** Cancels any in-progress edit, restoring the original text (no message sent). */
  cancel(): void {
    const el = this.target;
    if (!el) return;
    this.target = undefined;
    el.textContent = this.originalText;
    el.removeEventListener('keydown', this.handleKeyDown);
    el.removeEventListener('blur', this.handleBlur);
    el.removeAttribute('contenteditable');
    el.style.outline = this.previousOutline;
  }

  private send(message: ContentToPanelMessage): void {
    chrome.runtime.sendMessage(message).catch(() => {
      /* panel may be closed; ignore */
    });
  }
}
