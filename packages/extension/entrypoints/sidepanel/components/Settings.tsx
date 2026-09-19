import { useState, type CSSProperties } from 'react';
import type { VizionSettings } from '../hooks/useSettings.js';

type Props = {
  settings: VizionSettings;
  onSave: (next: VizionSettings) => void;
};

const fieldStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 4,
  fontFamily: 'inherit',
  fontSize: 13,
};

/**
 * Small collapsible "Réglages" section for the port and pairing token the
 * side panel connects to the local Vizion server with. Kept unmounted in
 * state until the user edits it, so switching tabs doesn't clobber unsaved
 * input with the persisted settings.
 */
export default function Settings({ settings, onSave }: Props) {
  const [port, setPort] = useState(String(settings.port));
  const [token, setToken] = useState(settings.token);

  const save = () => {
    const parsedPort = Number.parseInt(port, 10);
    onSave({
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : settings.port,
      token: token.trim(),
    });
  };

  return (
    <details style={{ marginTop: 12 }}>
      <summary style={{ fontSize: 13, cursor: 'pointer' }}>Réglages</summary>
      <div style={{ marginTop: 8 }}>
        <label style={{ fontSize: 12, color: '#444', display: 'block' }}>
          Port
          <input style={fieldStyle} value={port} onChange={(e) => setPort(e.target.value)} />
        </label>

        <label style={{ fontSize: 12, color: '#444', display: 'block', marginTop: 8 }}>
          Jeton d'appairage
          <input style={fieldStyle} value={token} onChange={(e) => setToken(e.target.value)} />
        </label>

        <p style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
          Le jeton s'affiche au démarrage de `npx vizion`.
        </p>

        <button style={{ marginTop: 6 }} onClick={save}>
          Enregistrer
        </button>
      </div>
    </details>
  );
}
