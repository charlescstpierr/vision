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
import { useVizionServer } from './hooks/useVizionServer.js';
import { useActiveTab } from './hooks/useActiveTab.js';
import { useApplyChange } from './hooks/useApplyChange.js';
import { useSettings } from './hooks/useSettings.js';
import { initialRunState, runReducer } from './state/runState.js';
import { isLocalUrl } from '../../utils/url.js';
import { addOverrides } from '../../utils/override-store.js';
import { proposalToOverrides } from '../../utils/proposal.js';

async function sendToActiveTab(message: PanelToContentMessage): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return chrome.tabs.sendMessage(tab.id, message);
}

/** `chrome.storage.local` key for the "Joindre une capture" checkbox, kept separate from `vizion:settings` so toggling it never touches the server connection settings. */
const ATTACH_SCREENSHOT_STORAGE_KEY = 'vizion:settings.attachScreenshot';

/** Strips the `captureElementScreenshot` "Capture impossible : " prefix so its reason can be reused in the panel's own notice wording. */
function captureFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Capture impossible\s*:\s*/, '');
}

export default function App() {
  const { settings, save: saveSettings } = useSettings();
  const server = useVizionServer(settings);
  const tabUrl = useActiveTab();
  const [selectMode, setSelectMode] = useState(false);
  const [elements, setElements] = useState<ElementContext[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [run, dispatch] = useReducer(runReducer, initialRunState);
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [attachScreenshot, setAttachScreenshotState] = useState(true);
  const [capturing, setCapturing] = useState(false);
  // True once the user has explicitly removed a staged capture ("Retirer")
  // without having sent it yet — distinguishes "Envoyer sans capture" from
  // the initial "Envoyer à l'agent" (no capture attempted yet).
  const [screenshotDismissed, setScreenshotDismissed] = useState(false);

  useEffect(() => server.subscribe((message) => dispatch({ type: 'server', message })), [server]);

  // Load the persisted "Joindre une capture" preference once on mount.
  useEffect(() => {
    let cancelled = false;
    void chrome.storage.local.get(ATTACH_SCREENSHOT_STORAGE_KEY).then((result) => {
      if (cancelled) return;
      const stored = result[ATTACH_SCREENSHOT_STORAGE_KEY];
      if (typeof stored === 'boolean') setAttachScreenshotState(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setAttachScreenshot = (next: boolean) => {
    setAttachScreenshotState(next);
    void chrome.storage.local.set({ [ATTACH_SCREENSHOT_STORAGE_KEY]: next });
  };

  // Clear the current selection when the active tab navigates elsewhere;
  // the run/diff state is left alone since it belongs to the agent run, not
  // to whichever element happened to be selected.
  useEffect(() => {
    setElements([]);
    setScreenshotDismissed(false);
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

  // A capture only counts as staged until it has been sent with a run; a
  // capture from a previous run is never reused silently.
  const stagedScreenshot = run.screenshot && !run.screenshotSent ? run.screenshot : null;

  // Drives the "Envoyer..." button's label through the stage → send flow.
  const sendLabel = capturing
    ? 'Capture en cours...'
    : attachScreenshot && stagedScreenshot
      ? 'Envoyer avec la capture'
      : attachScreenshot && screenshotDismissed
        ? 'Envoyer sans capture'
        : "Envoyer à l'agent";

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
        if (!message.append) setSelectMode(false);
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

  /** Captures the selected element(s) and stages the result as `run.screenshot` (not sent yet). */
  const captureAndStage = async (): Promise<Screenshot | null> => {
    setCapturing(true);
    setNotice(undefined);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('onglet actif introuvable');
      const screenshot = await captureElementScreenshot(
        tab.id,
        tab.windowId,
        elements.map((el) => el.selector),
      );
      dispatch({ type: 'set-screenshot', screenshot });
      setScreenshotDismissed(false);
      return screenshot;
    } catch (err) {
      setNotice(`Capture impossible, envoi sans image : ${captureFailureReason(err)}`);
      return null;
    } finally {
      setCapturing(false);
    }
  };

  const removeStagedScreenshot = () => {
    dispatch({ type: 'set-screenshot', screenshot: null });
    setScreenshotDismissed(true);
  };

  const retakeScreenshot = () => {
    void captureAndStage();
  };

  // First click (checkbox on, nothing staged yet): captures and stages the
  // screenshot, then stops — the button relabels to prompt a second click.
  // Any other click actually starts and sends the run, attaching whatever
  // is staged (if the checkbox is on).
  const runAgent = async (agent: AgentKind, promptText: string) => {
    if (elements.length === 0 || !tabUrl) return;

    if (attachScreenshot && !stagedScreenshot) {
      const captured = await captureAndStage();
      if (captured) return;
      // Capture failed: fall through and send this click without an image,
      // as before, instead of forcing a third click.
    }

    const screenshot = attachScreenshot ? stagedScreenshot : null;
    dispatch({ type: 'start', agent, prompt: promptText, pageKey: overrideKey(tabUrl) });
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

      <OverridePanel element={elements[0]} tabUrl={tabUrl} />

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
        runs={run.runs}
        undoNotice={run.undoNotice}
        error={run.error}
        onUndoRun={(id) => server.send({ type: 'undo-run', id })}
        attachScreenshot={attachScreenshot}
        onToggleAttachScreenshot={setAttachScreenshot}
        capturing={capturing}
        screenshot={run.screenshot}
        screenshotSent={run.screenshotSent}
        screenshotDismissed={screenshotDismissed}
        sendLabel={sendLabel}
        onRemoveScreenshot={removeStagedScreenshot}
        onRetakeScreenshot={retakeScreenshot}
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
