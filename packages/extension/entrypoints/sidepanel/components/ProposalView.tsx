import type { CSSProperties } from 'react';
import type { OverrideProposal } from '@vizion/shared';

type Props = {
  overrides: OverrideProposal[];
  note?: string;
  /** Page key (`overrideKey`) of the page this proposal was generated for. */
  pageKey: string;
  /** Page key of the tab currently active, when known. */
  currentPageKey?: string;
  /** Set when the last attempt to persist this proposal's overrides failed. */
  error?: string | null;
  onApply: () => void;
  onIgnore: () => void;
};

const VALUE_TRUNCATE_LIMIT = 80;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Renders a page key (an origin + pathname URL) as a short "host/path" label. */
function formatPageKey(pageKey: string): string {
  try {
    const url = new URL(pageKey);
    return `${url.host}${url.pathname}`;
  } catch {
    return pageKey;
  }
}

const badgeStyle: CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 4,
  background: '#e6e6ff',
  color: '#33308a',
  flex: '0 0 auto',
};

const selectorStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  wordBreak: 'break-all',
};

export default function ProposalView({ overrides, note, pageKey, currentPageKey, error, onApply, onIgnore }: Props) {
  const pageMismatch = currentPageKey !== undefined && currentPageKey !== pageKey;

  return (
    <div style={{ marginTop: 12, border: '1px solid #ddd', borderRadius: 8, padding: 10 }}>
      <strong style={{ fontSize: 13 }}>
        Proposition de l'agent ({overrides.length} override{overrides.length === 1 ? '' : 's'})
      </strong>

      {note && <p style={{ fontSize: 12, fontStyle: 'italic', color: '#444', marginTop: 6 }}>{note}</p>}

      {pageMismatch && (
        <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>
          Cette proposition concerne une autre page ({formatPageKey(pageKey)}) ; retourne sur cette page pour
          l'appliquer.
        </p>
      )}

      {error && (
        <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>
          Impossible d'enregistrer les overrides : {error}
        </p>
      )}

      {overrides.length === 0 && (
        <p style={{ fontSize: 12, color: '#666', marginTop: 8 }}>L'agent n'a rien proposé.</p>
      )}

      {overrides.map((override, index) => (
        <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12 }}>
          <span style={badgeStyle}>{override.kind === 'style' ? 'style' : 'texte'}</span>
          <span style={selectorStyle}>{truncate(override.selector, 40)}</span>
          <span style={{ color: '#666' }}>
            {override.kind === 'style'
              ? `${override.property} → ${truncate(override.value, VALUE_TRUNCATE_LIMIT)}`
              : truncate(override.value, VALUE_TRUNCATE_LIMIT)}
          </span>
        </div>
      ))}

      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button onClick={onApply} disabled={overrides.length === 0 || pageMismatch}>
          Appliquer
        </button>
        <button onClick={onIgnore}>Ignorer</button>
      </div>
    </div>
  );
}
