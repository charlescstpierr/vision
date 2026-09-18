import { useEffect, useState } from 'react';
import { DEFAULT_PORT } from '@vizion/shared';
import type { ContentToPanelMessage, ElementContext, PanelToContentMessage } from '@vizion/shared';
import ElementCard from './components/ElementCard.js';

type Status = { kind: 'loading' } | { kind: 'connected'; cwd: string } | { kind: 'disconnected' };

async function sendToActiveTab(message: PanelToContentMessage): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, message);
}

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [selectMode, setSelectMode] = useState(false);
  const [element, setElement] = useState<ElementContext | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

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

  useEffect(() => {
    const listener = (message: ContentToPanelMessage) => {
      if (message.type === 'vizion:element-selected') {
        setElement(message.element);
        setSelectMode(false);
      } else if (message.type === 'vizion:select-mode-changed') {
        setSelectMode(message.enabled);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const toggleSelectMode = async () => {
    const next = !selectMode;
    setNotice(undefined);
    try {
      await sendToActiveTab({ type: 'vizion:set-select-mode', enabled: next });
      setSelectMode(next);
    } catch {
      setNotice('Reload the page to enable Vizion on it.');
    }
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Vizion</h1>
      {status.kind === 'loading' && <p>Checking server...</p>}
      {status.kind === 'connected' && <p>Connected to {status.cwd}</p>}
      {status.kind === 'disconnected' && <p>Server not running. Run `npx vizion` in your project.</p>}

      <button onClick={toggleSelectMode} style={{ marginTop: 8 }}>
        {selectMode ? 'Cancel (Esc)' : 'Select element'}
      </button>

      {notice && (
        <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>{notice}</p>
      )}

      {element && <ElementCard element={element} onClear={() => setElement(undefined)} />}
    </div>
  );
}
