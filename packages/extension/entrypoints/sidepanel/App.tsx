import { useEffect, useReducer, useRef, useState } from 'react';
import type { AgentKind, ContentToPanelMessage, ElementContext, PanelToContentMessage, Screenshot } from '@vizion/shared';
import { overrideKey } from '@vizion/shared';
import { captureElementScreenshot } from '../../utils/screenshot.js';
import ElementCard from './components/ElementCard.js';
import RunPanel from './components/RunPanel.js';
import AgentOutput from './components/AgentOutput.js';
import DiffView from './components/DiffView.js';
import ProposalView from './components/ProposalView.js';
import OverridePanel from './components/OverridePanel.js';
import QuickStyles from './components/QuickStyles.js';
import SettingsPanel from './components/Settings.js';
import PairingPrompt from './components/PairingPrompt.js';
import { useVizionServer } from './hooks/useVizionServer.js';
import { useActiveTab } from './hooks/useActiveTab.js';
import { useApplyChange } from './hooks/useApplyChange.js';
import { useSettings } from './hooks/useSettings.js';
import { usePendingPairing } from './hooks/usePendingPairing.js';
import { initialRunState, runReducer } from './state/runState.js';
import { isLocalUrl } from '../../utils/url.js';
import { addOverrides } from '../../utils/override-store.js';
import { proposalToOverrides } from '../../utils/proposal.js';

async function sendToActiveTab(message: PanelToContentMessage): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, message);
}

/** Strips the `captureElementScreenshot` "Capture impossible : " prefix so its reason can be reused in the panel's own notice wording. */
function captureFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Capture impossible\s*:\s*/, '');
}

export default function App() {
  const { settings, save: saveSettings } = useSettings();
  const { pending: pendingPairing, dismiss: dismissPairing } = usePendingPairing();
  const server = useVizionServer(settings);
  const tabUrl = useActiveTab();
  const [selectMode, setSelectMode] = useState(false);
  const [elements, setElements] = useState<ElementContext[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [run, dispatch] = useReducer(runReducer, initialRunState);
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => server.subscribe((message) => dispatch({ type: 'server', message })), [server]);

  // Clear the current selection when the active tab navigates elsewhere;
  // the run/diff state is left alone since it belongs to the agent run, not
  // to whichever element happened to be selected.
  useEffect(() => {
    setElements([]);
  }, [tabUrl]);

  // Fetch the agent run history as soon as the server says hello (on
  // connect, and on every reconnect). `server.send` is a stable callback
  // (see useVizionServer), so it's deliberately left out of the deps below:
  // including the `server` handle itself would re-fire this on every
  // render, since that handle is a fresh object each time.
  useEffect(() => {
    if (server.hello) {
      server.send({ type: 'list-history' });
    }
  }, [server.hello]);

  const sendLabel = capturing ? 'Capture...' : "Envoyer à l'agent";

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
        setElements((prev) => {
          if (!message.append) return [message.element];
          if (prev.some((e) => e.selector === message.element.selector)) return prev;
          return [...prev, message.element];
        });
        if (!message.append) {
          setSelectMode(false);
          // Selecting an element is only ever a prelude to describing a
          // change, so put the cursor where the user is going anyway.
          promptRef.current?.focus();
        }
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

  /** Captures the selected element(s). Returns null (with a notice) if the capture fails. */
  const capture = async (): Promise<Screenshot | null> => {
    setCapturing(true);
    setNotice(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('onglet actif introuvable');
      return await captureElementScreenshot(
        tab.id,
        tab.windowId,
        elements.map((el) => el.selector),
      );
    } catch (err) {
      setNotice(`Capture impossible, envoi sans image : ${captureFailureReason(err)}`);
      return null;
    } finally {
      setCapturing(false);
    }
  };

  // One click: capture, then send. The capture used to be a checkbox plus a
  // two-click stage-then-send, which asked the user to decide something they
  // almost always wanted — seeing the element is what lets the agent act on
  // "this one". A failed capture sends without the image rather than
  // stopping, so the run never depends on it.
  const runAgent = async (agent: AgentKind, promptText: string) => {
    if (elements.length === 0 || !tabUrl) return;

    const screenshot = await capture();
    dispatch({ type: 'start', agent, prompt: promptText, pageKey: overrideKey(tabUrl), screenshot });
    const sent = server.send({
      type: 'run',
      agent,
      prompt: promptText,
      element: elements[0]!,
      elements,
      mode: isSourceMode ? 'source' : 'overlay',
      ...(screenshot ? { screenshot } : {}),
    });
    if (!sent) {
      dispatch({ type: 'send-failed' });
    }
  };

  const applyProposal = async () => {
    if (!run.proposal) return;
    const overrides = proposalToOverrides(run.proposal.overrides, Date.now(), () => crypto.randomUUID());
    try {
      // Apply under the page the proposal was generated for, captured when
      // the run started — not the tab that happens to be active now.
      await addOverrides(run.proposal.pageKey, overrides);
      setNotice(`${overrides.length} override(s) appliqué(s)`);
      dispatch({ type: 'clear-proposal' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: 'proposal-error', message });
    }
  };

  const ignoreProposal = () => {
    dispatch({ type: 'clear-proposal' });
  };

  const editText = (selector: string) => {
    void sendToActiveTab({ type: 'vizion:edit-text', selector }).catch(() => {
      setNotice('Recharge la page pour activer Vizion dessus.');
    });
  };

  const removeElement = (selector: string) => {
    setElements((prev) => prev.filter((e) => e.selector !== selector));
  };

  const clearElements = () => setElements([]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Vizion</h1>
      {/* One line covers both the mode (Source/Overlay) and the connection state —
          they used to be two separate lines saying the same thing twice. */}
      <p style={{ fontSize: 12, color: '#666', margin: 0 }}>
        {connected && server.hello
          ? isSourceMode
            ? `Mode Source · connecté à ${server.hello.cwd}`
            : `Mode Overlay (page distante) · connecté à ${server.hello.cwd}`
          : server.status === 'connecting'
            ? 'Connexion au serveur...'
            : settings.token === ''
              ? "Serveur non démarré ou non appairé. Lance `npx vizion` dans ton projet, puis ouvre l'URL d'appairage qu'il affiche."
              : 'Serveur non démarré. Lance `npx vizion` dans ton projet.'}
      </p>

      <PairingPrompt
        pending={pendingPairing}
        currentPort={settings.port}
        onConfirm={(pairing) => {
          saveSettings({ port: pairing.port, token: pairing.token });
          dismissPairing();
        }}
        onDismiss={dismissPairing}
      />

      <SettingsPanel settings={settings} onSave={saveSettings} />

      <button onClick={toggleSelectMode} style={{ marginTop: 8 }}>
        {selectMode ? 'Annuler (Échap)' : 'Sélectionner un élément'}
      </button>

      {notice && <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>{notice}</p>}

      {elements.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {elements.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 13 }}>Éléments sélectionnés ({elements.length})</strong>
              <button onClick={clearElements} style={{ fontSize: 12 }}>
                Tout effacer
              </button>
            </div>
          )}
          {elements.map((el) => (
            <ElementCard
              key={el.selector}
              element={el}
              compact={elements.length > 1}
              onClear={() => (elements.length > 1 ? removeElement(el.selector) : clearElements())}
              onEditText={() => editText(el.selector)}
            />
          ))}
        </div>
      )}

      {elements.length > 0 && (
        <QuickStyles
          key={elements.map((e) => e.selector).join('|')}
          element={elements[0]!}
          onApply={(changes) => applyStyleChanges(elements, changes)}
        />
      )}

      {/* Overlay overrides make no sense in Source mode: there, the agent edits the real files. */}
      {!isSourceMode && <OverridePanel element={elements[0]} tabUrl={tabUrl} />}

      <RunPanel
        agents={server.hello?.agents ?? []}
        connected={connected}
        isSourceMode={isSourceMode}
        elementSelected={elements.length > 0}
        running={run.running}
        prompt={prompt}
        setPrompt={setPrompt}
        promptRef={promptRef}
        onRun={runAgent}
        onCancel={() => server.send({ type: 'cancel' })}
        runs={run.runs}
        undoNotice={run.undoNotice}
        error={run.error}
        undoConflict={run.undoConflict}
        onUndoRun={(id, force) => server.send({ type: 'undo-run', id, force })}
        capturing={capturing}
        screenshot={run.screenshot}
        sendLabel={sendLabel}
      />

      <AgentOutput events={run.events} />

      {run.diff && <DiffView files={run.diff} error={run.error} />}

      {run.proposal && (
        <ProposalView
          overrides={run.proposal.overrides}
          note={run.proposal.note}
          pageKey={run.proposal.pageKey}
          currentPageKey={tabUrl ? overrideKey(tabUrl) : undefined}
          error={run.proposalError}
          onApply={() => void applyProposal()}
          onIgnore={ignoreProposal}
        />
      )}

      {run.error && !run.diff && run.events.length === 0 && (
        <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>{run.error}</p>
      )}
    </div>
  );
}
