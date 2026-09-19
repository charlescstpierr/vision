import path from 'node:path';
import type { PluginObj, PluginPass } from '@babel/core';
import type { types as BabelTypes } from '@babel/core';

export interface BabelPluginSourceOptions {
  /** Directory that emitted paths are made relative to. Defaults to `state.cwd` or `process.cwd()`. */
  root?: string;
  /** Attribute name to add. Defaults to `data-vizion-source`. */
  attribute?: string;
}

/**
 * Babel plugin that annotates every JSX host element (e.g. `div`, `button`)
 * with a `data-vizion-source="<relative file>:<line>:<column>"` attribute,
 * so the Vizion extension/agent can find the exact source location of a
 * clicked element without guessing from the DOM alone.
 *
 * Only host elements (lowercase tag names) are annotated. Custom components
 * (`<App />`, `<Foo.Bar />`) are skipped because React components do not
 * automatically forward unknown props to the DOM, so an attribute added to
 * `<App data-vizion-source="..." />` would not end up in the rendered HTML
 * and could break components with strict prop validation.
 */
export default function babelPluginSource(
  api: { types: typeof BabelTypes },
  options: BabelPluginSourceOptions = {},
): PluginObj {
  const { types: t } = api;
  const attributeName = options.attribute ?? 'data-vizion-source';

  return {
    name: '@vizion/babel-plugin-source',
    visitor: {
      JSXOpeningElement(path, state: PluginPass) {
        const { node } = path;

        if (!node.loc) return;

        const nameNode = node.name;
        if (nameNode.type !== 'JSXIdentifier') return; // skip <Foo.Bar />, fragments have no name
        if (!/^[a-z]/.test(nameNode.name)) return; // skip components like <App />

        const alreadyAnnotated = node.attributes.some(
          (attr) => attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === attributeName,
        );
        if (alreadyAnnotated) return;

        const filename = state.filename ?? state.file?.opts?.filename;
        if (!filename) return;

        const root = options.root ?? state.cwd ?? process.cwd();
        const relative = toRelativePath(root, filename);
        const value = `${relative}:${node.loc.start.line}:${node.loc.start.column + 1}`;

        node.attributes.push(t.jsxAttribute(t.jsxIdentifier(attributeName), t.stringLiteral(value)));
      },
    },
  };
}

function toRelativePath(root: string, filename: string): string {
  return path.relative(root, filename).split(path.sep).join('/');
}
