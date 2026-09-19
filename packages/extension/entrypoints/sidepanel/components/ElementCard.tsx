import { Fragment, type CSSProperties } from 'react';
import type { ElementContext } from '@vizion/shared';

type Props = {
  element: ElementContext;
  onClear: () => void;
  onEditText: () => void;
};

const cardStyle: CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 8,
  padding: 12,
  marginTop: 12,
};

const chipStyle: CSSProperties = {
  display: 'inline-block',
  background: '#eef2ff',
  color: '#3346a8',
  borderRadius: 4,
  padding: '1px 6px',
  fontSize: 11,
  marginRight: 4,
  marginBottom: 4,
};

const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  wordBreak: 'break-all',
};

export default function ElementCard({ element, onClear, onEditText }: Props) {
  const width = Math.round(element.rect.width);
  const height = Math.round(element.rect.height);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>Élément sélectionné</strong>
        <button onClick={onClear} style={{ fontSize: 12 }}>
          Effacer
        </button>
      </div>

      <p style={{ ...monoStyle, marginTop: 8 }}>
        &lt;{element.tagName}&gt; {element.selector}
      </p>

      <button onClick={onEditText} style={{ fontSize: 12, marginTop: 4 }}>
        Modifier le texte
      </button>

      {element.classes.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {element.classes.map((c) => (
            <span key={c} style={chipStyle}>
              .{c}
            </span>
          ))}
        </div>
      )}

      {element.textContent && (
        <p style={{ fontSize: 12, color: '#444', marginTop: 8 }}>
          {element.textContent}
        </p>
      )}

      <p style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
        {width}×{height}px
      </p>

      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 12, cursor: 'pointer' }}>Styles calculés</summary>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 8,
            rowGap: 2,
            marginTop: 6,
            fontSize: 11,
          }}
        >
          {Object.entries(element.computedStyles).map(([key, value]) => (
            <Fragment key={key}>
              <span style={{ color: '#888' }}>{key}</span>
              <span style={monoStyle}>{value}</span>
            </Fragment>
          ))}
        </div>
      </details>
    </div>
  );
}
