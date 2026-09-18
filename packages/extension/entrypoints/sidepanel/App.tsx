import { useEffect, useReducer, useRef, useState } from 'react';
import type { AgentKind, ContentToPanelMessage, ElementContext, PanelToContentMessage } from '@vizion/shared';
import ElementCard from './components/ElementCard.js';
import RunPanel from './components/RunPanel.js';
import AgentOutput from './components/AgentOutput.js';
import DiffView from './components/DiffView.js';
import OverridePanel from './components/OverridePanel.js';
import QuickStyles from './components/QuickStyles.js';
import { useVizionServer } from './hooks/useVizionServer.js';
import { useActiveTab } from './hooks/useActiveTab.js';
import { useApplyChange } from './hooks/useApplyChange.js';
import { initialRunState, runReducer } from './state/runState.js';

async function sendToActiveTab(message: PanelToContentMessage): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, message);
}

export default function App() {
  const server = useVizionServer();
  const tabUrl = useActiveTab();
  const [selectMode, setSelectMode] = useState(false);
  const [element, setElement] = useState<ElementContext | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [run, dispatch] = useReducer(runReducer, initialRunState);
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => server.subscribe((message) => dispatch({ type: 'server', message })), [server]);

  const connected = server.status === 'connected';

  const { applyStyleChanges, applyTextEdit } = useApplyChange({
    connected,
    tabUrl,
    prompt,
    setPrompt,
    focusPrompt: () => promptRef.current?.focus(),
  });

  useEffect(() => {
    const listener = (message: ContentToPanelMessage) => {
      if (message.type === 'vizion:element-selected') {
        setElement(message.element);
        setSelectMode(false);
      } else if (message.type === 'vizion:select-mode-changed') {
        setSelectMode(message.enabled);
      } else if (message.type === 'vizion:text-edited') {
        if (message.committed) {
          applyTextEdit(message.selector, message.before, message.after);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [applyTextEdit]);

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

  const runAgent = (agent: AgentKind, promptText: string) => {
    if (!element) return;
    dispatch({ type: 'start', agent, prompt: promptText });
    server.send({ type: 'run', agent, prompt: promptText, element });
  };

  const editText = () => {
    if (!element) return;
    void sendToActiveTab({ type: 'vizion:edit-text', selector: element.selector }).catch(() => {
      setNotice('Reload the page to enable Vizion on it.');
    });
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Vizion</h1>
      <p style={{ fontSize: 12, color: '#666', margin: 0 }}>
        {connected && server.hello ? `Source mode · ${server.hello.cwd}` : 'Overlay mode · no local server'}
      </p>

      {server.status === 'connecting' && <p>Connecting to server...</p>}
      {server.status === 'connected' && <p>Connected to {server.hello?.cwd}</p>}
      {server.status === 'disconnected' && <p>Server not running. Run `npx vizion` in your project.</p>}

      <button onClick={toggleSelectMode} style={{ marginTop: 8 }}>
        {selectMode ? 'Cancel (Esc)' : 'Select element'}
      </button>

      {notice && <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>{notice}</p>}

      {element && (
        <ElementCard element={element} onClear={() => setElement(undefined)} onEditText={editText} />
      )}

      {element && <QuickStyles element={element} onApply={(changes) => applyStyleChanges(element, changes)} />}

      <OverridePanel element={element} tabUrl={tabUrl} />

      <RunPanel
        agents={server.hello?.agents ?? []}
        connected={connected}
        elementSelected={!!element}
        running={run.running}
        prompt={prompt}
        setPrompt={setPrompt}
        promptRef={promptRef}
        onRun={runAgent}
      />

      <AgentOutput events={run.events} />

      {run.diff && (
        <DiffView
          files={run.diff}
          error={run.error}
          restoredFiles={run.restoredFiles}
          onAccept={() => server.send({ type: 'accept' })}
          onReject={() => server.send({ type: 'reject' })}
        />
      )}

      {run.error && !run.diff && run.events.length === 0 && (
        <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>{run.error}</p>
      )}
    </div>
  );
}
