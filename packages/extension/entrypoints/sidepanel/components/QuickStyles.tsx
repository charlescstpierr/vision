import { useState, type CSSProperties } from 'react';
import type { ElementContext } from '@vizion/shared';
import { rgbToHex } from '../../../utils/color.js';

export interface StyleChange {
  property: string;
  value: string;
}

type Props = {
  element: ElementContext;
  onApply: (changes: StyleChange[]) => void;
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 8,
};

const labelStyle: CSSProperties = {
  fontSize: 12,
  color: '#444',
  width: 90,
  flex: '0 0 auto',
};

const fieldStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
};

const FONT_WEIGHTS = ['400', '500', '600', '700'];
const TEXT_ALIGNS = ['left', 'center', 'right'];

function stripPx(value: string): string {
  return value.replace(/px$/, '');
}

/** One quick-style row: label, editable field(s), and its own Apply button. */
function Row(props: { label: string; children: React.ReactNode; onApply: () => void }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{props.label}</span>
      {props.children}
      <button style={{ flex: '0 0 auto' }} onClick={props.onApply}>
        Appliquer
      </button>
    </div>
  );
}

/**
 * Prefilled rows for the most common style tweaks (color, background,
 * font-size, font-weight, padding, margin, border-radius, text-align), each
 * with its own Apply button that only fires when the value actually changed
 * from the element's computed style.
 */
export default function QuickStyles({ element, onApply }: Props) {
  const computed = element.computedStyles;

  const [color, setColor] = useState(computed.color ?? '');
  const [background, setBackground] = useState(computed['background-color'] ?? '');
  const [fontSize, setFontSize] = useState(stripPx(computed['font-size'] ?? ''));
  const [fontWeight, setFontWeight] = useState(computed['font-weight'] ?? '400');
  const [padding, setPadding] = useState(computed.padding ?? '');
  const [margin, setMargin] = useState(computed.margin ?? '');
  const [borderRadius, setBorderRadius] = useState(stripPx(computed['border-radius'] ?? ''));
  const [textAlign, setTextAlign] = useState(computed['text-align'] ?? 'left');

  const applyIfChanged = (property: string, value: string, computedValue: string) => {
    if (value.trim().length === 0 || value === computedValue) return;
    onApply([{ property, value }]);
  };

  return (
    <div style={{ marginTop: 12 }}>
      <strong style={{ fontSize: 13 }}>Styles rapides</strong>

      <Row
        label="Couleur"
        onApply={() => applyIfChanged('color', color, computed.color ?? '')}
      >
        <input
          type="color"
          value={rgbToHex(color || computed.color || '#000000')}
          onChange={(e) => setColor(e.target.value)}
          style={{ flex: '0 0 auto' }}
        />
        <input style={fieldStyle} value={color} onChange={(e) => setColor(e.target.value)} />
      </Row>

      <Row
        label="Arrière-plan"
        onApply={() => applyIfChanged('background-color', background, computed['background-color'] ?? '')}
      >
        <input
          type="color"
          value={rgbToHex(background || computed['background-color'] || '#ffffff')}
          onChange={(e) => setBackground(e.target.value)}
          style={{ flex: '0 0 auto' }}
        />
        <input style={fieldStyle} value={background} onChange={(e) => setBackground(e.target.value)} />
      </Row>

      <Row
        label="Taille de police"
        onApply={() => applyIfChanged('font-size', `${fontSize}px`, computed['font-size'] ?? '')}
      >
        <input
          type="number"
          style={fieldStyle}
          value={fontSize}
          onChange={(e) => setFontSize(e.target.value)}
        />
        <span style={{ fontSize: 12, color: '#888' }}>px</span>
      </Row>

      <Row
        label="Graisse"
        onApply={() => applyIfChanged('font-weight', fontWeight, computed['font-weight'] ?? '')}
      >
        <select style={fieldStyle} value={fontWeight} onChange={(e) => setFontWeight(e.target.value)}>
          {FONT_WEIGHTS.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label="Espacement interne"
        onApply={() => applyIfChanged('padding', padding, computed.padding ?? '')}
      >
        <input style={fieldStyle} value={padding} onChange={(e) => setPadding(e.target.value)} />
      </Row>

      <Row
        label="Marge"
        onApply={() => applyIfChanged('margin', margin, computed.margin ?? '')}
      >
        <input style={fieldStyle} value={margin} onChange={(e) => setMargin(e.target.value)} />
      </Row>

      <Row
        label="Rayon"
        onApply={() => applyIfChanged('border-radius', `${borderRadius}px`, computed['border-radius'] ?? '')}
      >
        <input
          type="number"
          style={fieldStyle}
          value={borderRadius}
          onChange={(e) => setBorderRadius(e.target.value)}
        />
        <span style={{ fontSize: 12, color: '#888' }}>px</span>
      </Row>

      <Row
        label="Alignement du texte"
        onApply={() => applyIfChanged('text-align', textAlign, computed['text-align'] ?? '')}
      >
        <select style={fieldStyle} value={textAlign} onChange={(e) => setTextAlign(e.target.value)}>
          {TEXT_ALIGNS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}
