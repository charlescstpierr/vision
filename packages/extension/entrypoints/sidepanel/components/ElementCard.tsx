import type { CSSProperties } from 'react';
import type { ElementContext } from '@vizion/shared';

type Props = {
  element: ElementContext;
  onClear: () => void;
  onEditText: () => void;
  /** Compact row (tag + selector + "Retirer") used when several elements are selected. */
  compact?: boolean;
};

const cardStyle: CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 8,
  padding: 12,
  marginTop: 12,
};

const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  wordBreak: 'break-all',
};

export default function ElementCard({ element, onClear, onEditText, compact = false }: Props) {
  if (compact) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          border: '1px solid #ddd',
          borderRadius: 6,
          padding: '6px 10px',
          marginTop: 6,
        }}
      >
        <span style={monoStyle}>
          &lt;{element.tagName}&gt; {element.selector}
        </span>
        <button onClick={onClear} style={{ fontSize: 12, flex: '0 0 auto' }}>
          Retirer
        </button>
      </div>
    );
  }

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
    </div>
  );
}
