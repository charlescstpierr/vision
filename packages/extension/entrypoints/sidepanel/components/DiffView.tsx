import type { CSSProperties } from 'react';
import type { FileDiff } from '@vizion/shared';

type Props = {
  files: FileDiff[];
  error: string | null;
};

const badgeColors: Record<FileDiff['status'], { bg: string; fg: string }> = {
  modified: { bg: '#fff4cc', fg: '#8a6d00' },
  added: { bg: '#dcf5e0', fg: '#1f6b2c' },
  deleted: { bg: '#fbdada', fg: '#a83232' },
};

const preStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  background: '#f6f6f6',
  padding: 8,
  borderRadius: 4,
  maxHeight: 160,
  overflow: 'auto',
  whiteSpace: 'pre',
};

export default function DiffView({ files, error }: Props) {
  return (
    <div style={{ marginTop: 12, border: '1px solid #ddd', borderRadius: 8, padding: 10 }}>
      <strong style={{ fontSize: 13 }}>
        Modifié par le dernier run ({files.length} fichier{files.length === 1 ? '' : 's'})
      </strong>

      {files.length === 0 && (
        <p style={{ fontSize: 12, color: '#666', marginTop: 8 }}>L'agent n'a modifié aucun fichier.</p>
      )}

      {files.map((file) => {
        const badge = badgeColors[file.status];
        return (
          <div key={file.path} style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 12,
                  wordBreak: 'break-all',
                }}
              >
                {file.path}
              </span>
              <span
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: badge.bg,
                  color: badge.fg,
                }}
              >
                {file.status}
              </span>
            </div>
            <pre style={{ ...preStyle, marginTop: 4 }}>{file.patch}</pre>
          </div>
        );
      })}

      {error && <p style={{ fontSize: 12, color: '#a83232', marginTop: 8 }}>{error}</p>}
    </div>
  );
}
