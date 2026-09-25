import { useEffect, useReducer, useRef, useState } from 'react';
import type { AgentKind, ContentToPanelMessage, ElementContext, PanelToContentMessage, Screenshot } from '@vizion/shared';
import { overrideKey } from '@vizion/shared';
import { captureElementScreenshot } from '../../utils/screenshot.js';
import { renderAnnotatedScreenshot } from '../../utils/annotation-render.js';
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

/** How a capture attempt ended: staged for review, failed (the click may go on without an image), or outdated because the selection or page changed meanwhile. */
type CaptureOutcome = 'staged' | 'failed' | 'stale';

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
  // Bumped whenever the selection or page changes, so a capture finishing
  // afterwards is known to be outdated (see captureAndStage).
  const captureEpochRef = useRef(0);
  const selectionKey = elements.map((el) => el.selector).join('|');

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
  }, [tabUrl]);

  // A staged capture, and the marks drawn on it, shows the selection and page
  // it was taken from: once either changes it would point the agent at the
  // wrong target, so it is dropped instead of riding along with the next run.
  useEffect(() => {
    captureEpochRef.current += 1;
    dispatch({ type: 'discard-staged-screenshot' });
    setScreenshotDismissed(false);
  }, [selectionKey, tabUrl]);

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
      ? run.annotations.present.length > 0
        ? 'Envoyer avec la capture annotée'
        : 'Envoyer avec la capture'
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
  const captureAndStage = async (): Promise<CaptureOutcome> => {
    const epoch = captureEpochRef.current;
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
      // The selection or page changed while capturing: this image no longer
      // shows what a run would be about, so it is not staged.
      if (captureEpochRef.current !== epoch) return 'stale';
      dispatch({ type: 'set-screenshot', screenshot });
      setScreenshotDismissed(false);
      return 'staged';
    } catch (err) {
      setNotice(`Capture impossible, envoi sans image : ${captureFailureReason(err)}`);
      return 'failed';
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
  // screenshot, then stops — the button relabels to prompt a second click,
  // and the capture can be annotated in between. Any other click actually
  // sends and starts the run, attaching whatever is staged (if the checkbox
  // is on) with its marks flattened in.
  const runAgent = async (agent: AgentKind, promptText: string) => {
    if (elements.length === 0 || !tabUrl) return;

    if (attachScreenshot && !stagedScreenshot) {
      const outcome = await captureAndStage();
      if (outcome !== 'failed') return;
      // Capture failed: fall through and send this click without an image,
      // as before, instead of forcing a third click.
    }

    const staged = attachScreenshot ? stagedScreenshot : null;
    let screenshot: Screenshot | null = null;
    if (staged) {
      setCapturing(true);
      try {
        // Marks are flattened into the image only now, on the explicit send;
        // until this click they stay editable.
        screenshot = await renderAnnotatedScreenshot(staged, run.annotations.present);
      } catch (err) {
        setNotice(`Annotations impossibles à intégrer, run non envoyé : ${captureFailureReason(err)}`);
        return;
      } finally {
        setCapturing(false);
      }
    }

    const sent = server.send({
      type: 'run',
      agent,
      prompt: promptText,
      element: elements[0]!,
      elements,
      mode: isSourceMode ? 'source' : 'overlay',
      ...(screenshot ? { screenshot } : {}),
    });
    // Only a run that actually left starts: after a failed send the staged
    // capture and its marks stay staged, ready for the next click.
    if (!sent) {
      dispatch({ type: 'send-failed' });
      return;
    }
    dispatch({ type: 'start', agent, prompt: promptText, pageKey: overrideKey(tabUrl) });
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
          key={selectionKey}
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
        decisionPending={run.decision !== null}
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
        annotations={run.annotations}
        onAnnotate={dispatch}
        screenshotDismissed={screenshotDismissed}
        sendLabel={sendLabel}
        onRemoveScreenshot={removeStagedScreenshot}
        onRetakeScreenshot={retakeScreenshot}
      />

      <AgentOutput events={run.events} />

      {run.diff && run.decision?.state !== 'unavailable' && (
        <DiffView
          files={run.diff}
          error={run.error}
          restoredFiles={run.restoredFiles}
          state={run.decision?.state ?? 'pending'}
          connected={connected}
          onAccept={() => {
            if (run.decision) server.send({ type: 'accept', runId: run.decision.runId });
          }}
          onReject={() => {
            if (run.decision) server.send({ type: 'reject', runId: run.decision.runId });
          }}
        />
      )}

      {run.decision?.state === 'unavailable' && (
        <div role="alert" style={{ marginTop: 12, border: '1px solid #a83232', borderRadius: 8, padding: 10 }}>
          <p style={{ fontSize: 12, color: '#a83232' }}>
            Diff indisponible : les modifications restent en attente. {run.error}
          </p>
          <button disabled={!connected} onClick={() => server.send({ type: 'retry-diff', runId: run.decision!.runId })}>
            Réessayer le diff
          </button>
        </div>
      )}

      {run.restoredFiles && !run.decision && (
        <p style={{ color: '#1f6b2c', fontSize: 12 }}>
          {run.restoredFiles.length} fichier{run.restoredFiles.length === 1 ? '' : 's'} restauré{run.restoredFiles.length === 1 ? '' : 's'}.
        </p>
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

      {run.error && !run.decision && !run.diff && run.events.length === 0 && (
        <p style={{ color: '#a83232', fontSize: 12, marginTop: 8 }}>{run.error}</p>
      )}
    </div>
  );
}
