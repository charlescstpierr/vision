import { transformSync } from '@babel/core';
import { describe, expect, it } from 'vitest';
import babelPluginSource from './index.js';

const FILENAME = '/proj/src/App.tsx';

function transform(code: string, options?: Parameters<typeof babelPluginSource>[1]) {
  const result = transformSync(code, {
    filename: FILENAME,
    plugins: ['@babel/plugin-syntax-jsx', [babelPluginSource, { root: '/proj', ...options }]],
    babelrc: false,
    configFile: false,
  });
  return result?.code ?? '';
}

describe('babelPluginSource', () => {
  it('annotates host elements with file:line:column', () => {
    const code = transform(
      ['function App() {', '  return (', '    <div>', '      <button>Go</button>', '    </div>', '  );', '}'].join(
        '\n',
      ),
    );

    expect(code).toContain('data-vizion-source="src/App.tsx:3:5"');
    expect(code).toContain('data-vizion-source="src/App.tsx:4:7"');
  });

  it('does not annotate component elements', () => {
    const code = transform('function Root() {\n  return <App />;\n}');
    expect(code).not.toContain('data-vizion-source');
  });

  it('does not annotate namespaced/member component elements', () => {
    const code = transform('function Root() {\n  return <Foo.Bar />;\n}');
    expect(code).not.toContain('data-vizion-source');
  });

  it('does not duplicate an existing attribute', () => {
    const code = transform('function App() {\n  return <div data-vizion-source="already-there" />;\n}');
    const matches = code.match(/data-vizion-source/g) ?? [];
    expect(matches.length).toBe(1);
    expect(code).toContain('data-vizion-source="already-there"');
  });

  it('supports a custom attribute name', () => {
    const code = transform('function App() {\n  return <div />;\n}', { attribute: 'data-source-loc' });
    expect(code).toContain('data-source-loc="src/App.tsx:2:10"');
    expect(code).not.toContain('data-vizion-source');
  });
});
