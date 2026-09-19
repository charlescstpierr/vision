import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineEditor } from './inline-editor.js';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(() => Promise.resolve()) } });
});

describe('InlineEditor', () => {
  it('restores an absent contenteditable attribute on commit', () => {
    document.body.innerHTML = '<h1 class="title">hello</h1>';
    const el = document.querySelector('.title')!;
    const editor = new InlineEditor();
    editor.start('.title');
    expect(el.getAttribute('contenteditable')).toBe('true');
    el.dispatchEvent(new Event('blur'));
    expect(el.hasAttribute('contenteditable')).toBe(false);
  });

  it('restores a pre-existing contenteditable value on cancel', () => {
    document.body.innerHTML = '<h1 class="title" contenteditable="false">hello</h1>';
    const el = document.querySelector('.title')!;
    const editor = new InlineEditor();
    editor.start('.title');
    editor.cancel();
    expect(el.getAttribute('contenteditable')).toBe('false');
  });

  it('sends raw (non-collapsed) before/after text on commit', () => {
    document.body.innerHTML = '<h1 class="title">  hi   there  </h1>';
    const el = document.querySelector('.title')!;
    const sendMessage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const editor = new InlineEditor();
    editor.start('.title');
    el.textContent = '  hi   there   again  ';
    el.dispatchEvent(new Event('blur'));

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        before: '  hi   there  ',
        after: '  hi   there   again  ',
        committed: true,
      }),
    );
  });
});
