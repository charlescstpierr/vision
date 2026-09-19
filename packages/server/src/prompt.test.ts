import { describe, expect, it } from 'vitest';
import type { ElementContext, RunRequest } from '@vizion/shared';
import { buildPrompt } from './prompt.js';

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
});
