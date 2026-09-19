import { describe, expect, it } from 'vitest';
import type { ElementContext, RunRequest } from '@vizion/shared';
import { buildOverlayPrompt, buildPrompt } from './prompt.js';

function makeRequest(overrides: Partial<ElementContext> = {}): RunRequest {
  const element: ElementContext = {
    selector: '#app > button.primary',
    tagName: 'button',
    classes: ['btn', 'primary'],
    textContent: 'Click me',
    outerHtml: '<button class="btn primary">Click me</button>',
    domPath: ['html', 'body', '#app', 'button.primary'],
    rect: { x: 0, y: 0, width: 100, height: 40 },
    computedStyles: {},
    pageUrl: 'https://example.com/app',
    ...overrides,
  };
  return {
    agent: 'claude',
    prompt: 'make this button blue',
    element,
    pageUrl: 'https://example.com/app',
  };
}

describe('buildPrompt', () => {
  it('includes the cwd, page url, selector, dom path, classes, text, html and task', () => {
    const req = makeRequest();
    const prompt = buildPrompt(req, '/home/user/my-project');

    expect(prompt).toContain('/home/user/my-project');
    expect(prompt).toContain('https://example.com/app');
    expect(prompt).toContain('#app > button.primary');
    expect(prompt).toContain('html > body > #app > button.primary');
    expect(prompt).toContain('btn primary');
    expect(prompt).toContain('Click me');
    expect(prompt).toContain('<button class="btn primary">Click me</button>');
    expect(prompt).toContain('make this button blue');
    expect(prompt).toContain(
      'Find the source file that renders this element, apply the requested change, and touch nothing else.',
    );
  });

  it('shows (none) when there are no classes', () => {
    const req = makeRequest({ classes: [] });
    const prompt = buildPrompt(req, '/tmp/proj');
    expect(prompt).toContain('Classes: (none).');
  });

  it('adds the source location line right after the selected element line when present', () => {
    const req = makeRequest({ sourceLocation: 'src/App.tsx:3:5' });
    const prompt = buildPrompt(req, '/tmp/proj');
    const lines = prompt.split('\n');
    const selectedIndex = lines.findIndex((line) => line.startsWith('Selected element:'));
    expect(lines[selectedIndex + 1]).toBe(
      'Source location (from build annotation): src/App.tsx:3:5. Start there.',
    );
  });

  it('omits the source location line when not present', () => {
    const req = makeRequest();
    const prompt = buildPrompt(req, '/tmp/proj');
    expect(prompt).not.toContain('Source location');
  });

  it('truncates a very long outerHtml', () => {
    const longHtml = `<div>${'x'.repeat(3000)}</div>`;
    const req = makeRequest({ outerHtml: longHtml });
    const prompt = buildPrompt(req, '/tmp/proj');

    expect(prompt).not.toContain(longHtml);
    expect(prompt).toContain('(truncated)');
    expect(prompt.length).toBeLessThan(longHtml.length + 500);
  });

  it('describes multiple elements as a numbered list and phrases the task for all of them', () => {
    const req = makeRequest();
    const second: ElementContext = {
      selector: '.card__title',
      tagName: 'h2',
      classes: ['card__title'],
      textContent: 'Title',
      outerHtml: '<h2 class="card__title">Title</h2>',
      domPath: ['html', 'body', '.card', 'h2.card__title'],
      rect: { x: 0, y: 0, width: 50, height: 20 },
      computedStyles: {},
      pageUrl: 'https://example.com/app',
    };
    const prompt = buildPrompt({ ...req, elements: [req.element, second] }, '/tmp/proj');

    expect(prompt).toContain('Selected elements (2):');
    expect(prompt).toContain('1. Selector: #app > button.primary.');
    expect(prompt).toContain('2. Selector: .card__title.');
    expect(prompt).toContain('Title');
    expect(prompt).toContain('Apply the requested change to all of the elements listed above');
    expect(prompt).not.toContain('Selected element:');
  });

  it('truncates each element outerHtml at 800 chars in the multi-element format', () => {
    const req = makeRequest();
    const longHtml = `<div>${'y'.repeat(3000)}</div>`;
    const second: ElementContext = { ...req.element, selector: '.other', outerHtml: longHtml };
    const prompt = buildPrompt({ ...req, elements: [req.element, second] }, '/tmp/proj');

    expect(prompt).not.toContain(longHtml);
    expect(prompt).toContain('(truncated)');
  });

  it('keeps the single-element format when elements has exactly one entry', () => {
    const req = makeRequest();
    const single = buildPrompt({ ...req, elements: [req.element] }, '/tmp/proj');
    const noElements = buildPrompt(req, '/tmp/proj');
    expect(single).toBe(noElements);
  });
});

describe('buildOverlayPrompt', () => {
  it('lists the selector, forbids tools/edits, and states the JSON contract', () => {
    const req = makeRequest();
    const prompt = buildOverlayPrompt(req, '/home/user/my-project');

    expect(prompt).toContain('#app > button.primary');
    expect(prompt).toContain('"#app > button.primary"');
    expect(prompt).toContain('cannot edit any files');
    expect(prompt).toContain('must not use any tools');
    expect(prompt).toContain('```json');
    expect(prompt).toContain('"kind": "style"');
    expect(prompt).toContain('"property"');
    expect(prompt).toContain('"kind": "text"');
    expect(prompt).toContain('make this button blue');
  });

  it('lists every selector for a multi-element request', () => {
    const req = makeRequest();
    const second: ElementContext = { ...req.element, selector: '.card__title' };
    const prompt = buildOverlayPrompt({ ...req, elements: [req.element, second] }, '/tmp/proj');

    expect(prompt).toContain('Selected elements (2):');
    expect(prompt).toContain('"#app > button.primary"');
    expect(prompt).toContain('".card__title"');
  });

  it('JSON-escapes a selector containing backslashes and quotes so it round-trips', () => {
    // e.g. CSS.escape('123') === '\\31 23', used as `#\31 23`.
    const trickySelector = String.raw`#\31 23`;
    const req = makeRequest({ selector: trickySelector });
    const prompt = buildOverlayPrompt(req, '/tmp/proj');

    const encoded = JSON.stringify(trickySelector);
    expect(prompt).toContain(encoded);
    expect(JSON.parse(encoded)).toBe(trickySelector);
  });
});
