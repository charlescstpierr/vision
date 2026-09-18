import { useEffect, useState, type CSSProperties } from 'react';
import type { ElementContext, Override } from '@vizion/shared';
import { OVERRIDES_STORAGE_PREFIX, overrideKey } from '@vizion/shared';
import { addOverride, clearOverrides, loadOverrides, removeOverride } from '../../../utils/override-store.js';

type Props = {
  element: ElementContext | undefined;
  tabUrl: string | undefined;
};

const STYLE_PROPERTIES = [
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'padding',
  'margin',
  'border-radius',
  'display',
  'width',
  'height',
  'text-align',
  'opacity',
];

const fieldStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 4,
  fontFamily: 'inherit',
  fontSize: 13,
};

const rowStyle: CSSProperties = { marginTop: 10 };

const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
};

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function OverridePanel({ element, tabUrl }: Props) {
  const [property, setProperty] = useState(STYLE_PROPERTIES[0]!);
  const [value, setValue] = useState('');
  const [text, setText] = useState(element?.textContent ?? '');
  const [overrides, setOverrides] = useState<Override[]>([]);

  useEffect(() => {
    setText(element?.textContent ?? '');
  }, [element]);

  useEffect(() => {
    if (!tabUrl) {
      setOverrides([]);
      return;
    }
    let cancelled = false;
    void loadOverrides(tabUrl).then((loaded) => {
      if (!cancelled) setOverrides(loaded);
    });

    const storageKey = OVERRIDES_STORAGE_PREFIX + overrideKey(tabUrl);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !(storageKey in changes)) return;
      setOverrides((changes[storageKey]?.newValue as Override[] | undefined) ?? []);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [tabUrl]);

  const applyStyle = () => {
    if (!tabUrl || !element || value.trim().length === 0) return;
    void addOverride(tabUrl, {
      id: makeId(),
      selector: element.selector,
      kind: 'style',
      property,
      value: value.trim(),
      createdAt: Date.now(),
    }).then(setOverrides);
    setValue('');
  };

  const applyText = () => {
    if (!tabUrl || !element) return;
    void addOverride(tabUrl, {
      id: makeId(),
      selector: element.selector,
      kind: 'text',
      value: text,
      createdAt: Date.now(),
    }).then(setOverrides);
  };

  const remove = (id: string) => {
    if (!tabUrl) return;
    void removeOverride(tabUrl, id).then(setOverrides);
  };

  const clearAll = () => {
    if (!tabUrl) return;
    void clearOverrides(tabUrl).then(() => setOverrides([]));
  };

  return (
    <div style={{ marginTop: 12, border: '1px solid #ddd', borderRadius: 8, padding: 10 }}>
      <strong style={{ fontSize: 13 }}>Overlay overrides</strong>

      {!tabUrl && (
        <p style={{ fontSize: 12, color: '#666', marginTop: 8 }}>No active tab.</p>
      )}

      {element ? (
        <>
          <div style={rowStyle}>
            <label style={{ fontSize: 12, color: '#444', display: 'block' }}>
              Style
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <select
                  style={{ ...fieldStyle, marginTop: 0, flex: '0 0 auto' }}
                  value={property}
                  onChange={(e) => setProperty(e.target.value)}
                >
                  {STYLE_PROPERTIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  style={{ ...fieldStyle, marginTop: 0, flex: '1 1 auto' }}
                  placeholder="value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
            </label>
            <button style={{ marginTop: 6 }} disabled={!tabUrl || value.trim().length === 0} onClick={applyStyle}>
              Apply style
            </button>
          </div>

          <div style={rowStyle}>
            <label style={{ fontSize: 12, color: '#444', display: 'block' }}>
              Text
              <textarea
                style={{ ...fieldStyle, minHeight: 48, resize: 'vertical' }}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <button style={{ marginTop: 6 }} disabled={!tabUrl} onClick={applyText}>
              Apply text
            </button>
          </div>
        </>
      ) : (
        <p style={{ fontSize: 12, color: '#666', marginTop: 8 }}>Select an element to add an override.</p>
      )}

      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 12 }}>Overrides on this page ({overrides.length})</strong>
        {overrides.length > 0 && (
          <button style={{ fontSize: 12 }} onClick={clearAll}>
            Clear all
          </button>
        )}
      </div>

      {overrides.map((o) => (
        <div
          key={o.id}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 6,
            marginTop: 6,
            fontSize: 11,
          }}
        >
          <span style={{ ...monoStyle, wordBreak: 'break-all' }}>
            [{o.kind}] {truncate(o.selector, 30)} {o.kind === 'style' ? `${o.property}: ${o.value}` : `"${truncate(o.value, 24)}"`}
          </span>
          <button style={{ flex: '0 0 auto' }} onClick={() => remove(o.id)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
