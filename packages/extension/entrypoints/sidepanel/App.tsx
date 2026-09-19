import { useEffect, useReducer, useRef, useState } from 'react';
import type { AgentKind, ContentToPanelMessage, ElementContext, PanelToContentMessage } from '@vizion/shared';
import ElementCard from './components/ElementCard.js';
import RunPanel from './components/RunPanel.js';
import AgentOutput from './components/AgentOutput.js';
import DiffView from './components/DiffView.js';
import OverridePanel from './components/OverridePanel.js';
import QuickStyles from './components/QuickStyles.js';
import SettingsPanel from './components/Settings.js';
import { useVizionServer } from './hooks/useVizionServer.js';
import { useActiveTab } from './hooks/useActiveTab.js';
import { useApplyChange } from './hooks/useApplyChange.js';
import { useSettings } from './hooks/useSettings.js';
import { initialRunState, runReducer } from './state/runState.js';
import { isLocalUrl } from '../../utils/url.js';

async function sendToActiveTab(message: PanelToContentMessage): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, message);
}

export default function App() {
  const { settings, save: saveSettings } = useSettings();
  const server = useVizionServer(settings);
  const tabUrl = useActiveTab();
  const [selectMode, setSelectMode] = useState(false);
  const [element, setElement] = useState<ElementContext | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [run, dispatch] = useReducer(runReducer, initialRunState);
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => server.subscribe((message) => dispatch({ type: 'server', message })), [server]);

  // Clear the current selection when the active tab navigates elsewhere;
  // the run/diff state is left alone since it belongs to the agent run, not
  // to whichever element happened to be selected.
  useEffect(() => {
    setElement(undefined);
  }, [tabUrl]);

  const connected = server.status === 'connected';
  // Source mode requires both a live server connection and a local page:
  // editing a remote page's source makes no sense, so it stays in Overlay
  // mode even while connected.
  const isSourceMode = connected && isLocalUrl(tabUrl);

  const { applyStyleChanges, applyTextEdit } = useApplyChange({
    sourceMode: isSourceMode,
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
      setNotice('Recharge la page pour activer Vizion dessus.');
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
      setNotice('Recharge la page pour activer Vizion dessus.');
    });
  };

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Vizion</h1>
      <p style={{ fontSize: 12, color: '#666', margin: 0 }}>
        {isSourceMode && server.hello
          ? `Mode Source · ${server.hello.cwd}`
          : connected
            ? 'Mode Overlay · page distante'
            : 'Mode Overlay · aucun serveur local'}
      </p>

      {server.status === 'connecting' && <p>Connexion au serveur...</p>}
      {server.status === 'connected' && <p>Connecté à {server.hello?.cwd}</p>}
      {server.status === 'disconnected' &&
        (settings.token === '' ? (
          <p>
            Serveur non démarré ou jeton manquant. Lance `npx vizion` dans ton projet et colle le jeton dans les
            réglages.
          </p>
        ) : (
          <p>Serveur non démarré. Lance `npx vizion` dans ton projet.</p>
        ))}

      <SettingsPanel settings={settings} onSave={saveSettings} />

      <button onClick={toggleSelectMode} style={{ marginTop: 8 }}>
        {selectMode ? 'Annuler (Échap)' : 'Sélectionner un élément'}
      </button>

      {notice && <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>{notice}</p>}

      {element && (
        <ElementCard element={element} onClear={() => setElement(undefined)} onEditText={editText} />
      )}

      {element && (
        <QuickStyles
          key={element.selector}
          element={element}
          onApply={(changes) => applyStyleChanges(element, changes)}
        />
      )}

      <OverridePanel element={element} tabUrl={tabUrl} />

      <RunPanel
        agents={server.hello?.agents ?? []}
        connected={isSourceMode}
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
