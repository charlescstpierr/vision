import { describe, expect, it, beforeEach } from 'vitest';
import { buildUniqueSelector, buildDomPath, extractElementContext } from './dom.js';

function setBody(html: string) {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildUniqueSelector', () => {
  it('returns #id when the id is unique in the document', () => {
    setBody('<div><span id="target">hi</span></div>');
    const el = document.getElementById('target')!;
    expect(buildUniqueSelector(el)).toBe('#target');
  });

  it('falls back to nth-of-type when there is no id', () => {
    setBody('<div class="list"><p>a</p><p>b</p><p id="c-marker">c</p></div>');
    const paragraphs = document.querySelectorAll('.list p');
    const second = paragraphs[1]!;
    const selector = buildUniqueSelector(second);
    expect(selector).toContain('nth-of-type(2)');
  });

  it('always produces a selector unique in the document', () => {
    setBody(`
      <div class="a"><p>x</p><p>y</p></div>
      <div class="b"><p>x</p><p>y</p></div>
    `);
    const targets = document.querySelectorAll('.b p');
    for (const el of Array.from(targets)) {
      const selector = buildUniqueSelector(el);
      expect(document.querySelectorAll(selector).length).toBe(1);
    }
  });

  it('uses the nearest ancestor unique id as the anchor', () => {
    setBody('<div id="panel"><ul><li>one</li><li>two</li></ul></div>');
    const items = document.querySelectorAll('#panel li');
    const selector = buildUniqueSelector(items[1]!);
    expect(selector.startsWith('#panel')).toBe(true);
    expect(document.querySelectorAll(selector).length).toBe(1);
  });

  it('ignores duplicate non-unique ids and treats them as no id', () => {
    setBody('<div><span id="dup">a</span></div><div><span id="dup">b</span></div>');
    const spans = document.querySelectorAll('#dup');
    const second = spans[1]!;
    const selector = buildUniqueSelector(second);
    expect(document.querySelectorAll(selector).length).toBe(1);
  });
});

describe('buildDomPath', () => {
  it('formats each entry as tag#id.class and limits classes to 3', () => {
    setBody('<main id="main"><div class="a b c d e">child</div></main>');
    const child = document.querySelector('main > div')!;
    const path = buildDomPath(child);
    expect(path[0]).toBe('body');
    expect(path[1]).toBe('main#main');
    expect(path[2]).toBe('div.a.b.c');
  });

  it('omits id and class segments when absent', () => {
    setBody('<section><p>text</p></section>');
    const p = document.querySelector('p')!;
    const path = buildDomPath(p);
    expect(path).toEqual(['body', 'section', 'p']);
  });
});

describe('extractElementContext', () => {
  it('truncates outerHtml to 2000 chars and appends an ellipsis', () => {
    const longAttr = 'x'.repeat(3000);
    setBody(`<div id="big" data-x="${longAttr}"></div>`);
    const el = document.getElementById('big')!;
    const ctx = extractElementContext(el, 'https://example.com');
    expect(ctx.outerHtml.length).toBe(2001);
    expect(ctx.outerHtml.endsWith('…')).toBe(true);
  });

  it('does not append ellipsis when outerHtml is within the limit', () => {
    setBody('<div id="small">hi</div>');
    const el = document.getElementById('small')!;
    const ctx = extractElementContext(el, 'https://example.com');
    expect(ctx.outerHtml.endsWith('…')).toBe(false);
  });

  it('collapses whitespace and truncates textContent to 300 chars', () => {
    const longText = 'word '.repeat(200);
    setBody(`<p id="p">  ${longText}  </p>`);
    const el = document.getElementById('p')!;
    const ctx = extractElementContext(el, 'https://example.com');
    expect(ctx.textContent.length).toBe(301);
    expect(ctx.textContent.startsWith(' ')).toBe(false);
    expect(ctx.textContent.includes('  ')).toBe(false);
  });

  it('fills selector, tagName, classes, domPath and pageUrl', () => {
    setBody('<div id="root"><button class="btn primary">Go</button></div>');
    const btn = document.querySelector('button')!;
    const ctx = extractElementContext(btn, 'https://example.com/page');
    expect(ctx.tagName).toBe('button');
    expect(ctx.classes).toEqual(['btn', 'primary']);
    expect(ctx.selector).toContain('button');
    expect(ctx.domPath).toEqual(['body', 'div#root', 'button.btn.primary']);
    expect(ctx.pageUrl).toBe('https://example.com/page');
    expect(ctx.rect).toHaveProperty('width');
  });

  it('only includes the whitelisted computed style keys', () => {
    setBody('<div id="styled">x</div>');
    const el = document.getElementById('styled')!;
    const ctx = extractElementContext(el, 'https://example.com');
    expect(Object.keys(ctx.computedStyles).sort()).toEqual(
      [
        'color',
        'background-color',
        'font-size',
        'font-family',
        'font-weight',
        'line-height',
        'padding',
        'margin',
        'display',
        'width',
        'height',
        'border',
        'border-radius',
        'text-align',
      ].sort(),
    );
  });
});
