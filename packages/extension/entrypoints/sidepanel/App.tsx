import { useEffect, useState } from 'react';
import { DEFAULT_PORT } from '@vizion/shared';

type Status = { kind: 'loading' } | { kind: 'connected'; cwd: string } | { kind: 'disconnected' };

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`)
      .then((res) => res.json() as Promise<{ cwd: string }>)
      .then((data) => {
        if (!cancelled) setStatus({ kind: 'connected', cwd: data.cwd });
      })
      .catch(() => {
        if (!cancelled) setStatus({ kind: 'disconnected' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Vizion</h1>
      {status.kind === 'loading' && <p>Checking server...</p>}
      {status.kind === 'connected' && <p>Connected to {status.cwd}</p>}
      {status.kind === 'disconnected' && <p>Server not running. Run `npx vizion` in your project.</p>}
    </div>
  );
}
