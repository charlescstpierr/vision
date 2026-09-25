import { useEffect, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import type { AgentKind, RunRecord, Screenshot } from '@vizion/shared';
import type { Annotation } from '../../../utils/annotations.js';
import type { HistoryState } from '../../../utils/edit-history.js';
import type { AnnotationAction } from '../state/runState.js';
import CaptureThumbnail from './CaptureThumbnail.js';
import ScreenshotAnnotator from './ScreenshotAnnotator.js';

type Props = {
  agents: AgentKind[];
  connected: boolean;
  isSourceMode: boolean;
  elementSelected: boolean;
  running: boolean;
  decisionPending: boolean;
  prompt: string;
  setPrompt: (next: string) => void;
  promptRef?: RefObject<HTMLTextAreaElement>;
  onRun: (agent: AgentKind, prompt: string) => void;
  /** Past agent runs (from the server's `list-history`), in any order — this component sorts newest first. */
  runs: RunRecord[];
  undoNotice: string | null;
  /** Server-reported error to show inline next to the history (e.g. a failed `undo-run`). */
  error: string | null;
  onUndoRun: (id: string) => void;
  attachScreenshot: boolean;
  onToggleAttachScreenshot: (next: boolean) => void;
  /** True while `runAgent` is capturing the tab, before the run is actually sent. */
  capturing: boolean;
  /** The staged (not yet sent) or sent capture, if any. */
  screenshot: Screenshot | null;
  /** True once `screenshot` has actually been sent with a run. */
  screenshotSent: boolean;
  /** Marks drawn on `screenshot` (editable while it is staged) and their undo history. */
  annotations: HistoryState<Annotation>;
  onAnnotate: (action: AnnotationAction) => void;
  /** True once the user removed a staged capture ("Retirer") without sending it. */
  screenshotDismissed: boolean;
  /** Label for the send button, reflecting the stage → send flow (see App.tsx). */
  sendLabel: string;
  onRemoveScreenshot: () => void;
  onRetakeScreenshot: () => void;
};

const PROMPT_PREVIEW_LIMIT = 60;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('fr-CA');
}

const fieldStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  marginTop: 6,
  fontFamily: 'inherit',
  fontSize: 13,
};

export default function RunPanel({
  agents,
  connected,
  isSourceMode,
  elementSelected,
  running,
  decisionPending,
  prompt,
  setPrompt,
  promptRef,
  onRun,
  runs,
  undoNotice,
  error,
  onUndoRun,
  attachScreenshot,
  onToggleAttachScreenshot,
  capturing,
  screenshot,
  screenshotSent,
  annotations,
  onAnnotate,
  screenshotDismissed,
  sendLabel,
  onRemoveScreenshot,
  onRetakeScreenshot,
}: Props) {
  const [agent, setAgent] = useState<AgentKind | ''>(agents[0] ?? '');

  // Keep the selection valid as the detected agent list arrives/changes:
  // default to the first agent whenever the current pick isn't (or is no
  // longer) among them.
  useEffect(() => {
    if (agents.length > 0 && !agents.includes(agent as AgentKind)) {
      setAgent(agents[0]!);
    }
  }, [agents, agent]);

  const hasAgents = agents.length > 0;
  const canSend =
    connected && elementSelected && agent !== '' && prompt.trim().length > 0 && !running && !decisionPending && !capturing;

  const sortedRuns = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  const mostRecentAcceptedId = sortedRuns.find((r) => r.status === 'accepted')?.id;

  const submit = () => {
    if (!canSend) return;
    onRun(agent, prompt);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      <label style={{ fontSize: 12, color: '#444', display: 'block' }}>
        Agent
        <select
          style={fieldStyle}
          value={agent}
          disabled={!hasAgents}
          onChange={(e) => setAgent(e.target.value as AgentKind)}
        >
          {!hasAgents && <option value="">Aucun agent disponible</option>}
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      {!hasAgents && (
        <p style={{ fontSize: 12, color: '#a83232', marginTop: 4 }}>
          Aucun CLI d'agent détecté. Installe codex ou claude.
        </p>
      )}

      <label style={{ fontSize: 12, color: '#444', display: 'block', marginTop: 10 }}>
        Prompt
        <textarea
          ref={promptRef}
          style={{ ...fieldStyle, minHeight: 64, resize: 'vertical' }}
          placeholder="ex. Mets ce bouton en bleu"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>

      {connected && (
        <p style={{ fontSize: 12, color: '#444', marginTop: 8 }}>
          {isSourceMode
            ? "Mode Source : l'agent modifiera les fichiers du projet."
            : "Mode Overlay : l'agent proposera des overrides (styles / texte) pour cette page."}
        </p>
      )}

      <label style={{ fontSize: 12, color: '#444', display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
        <input
          type="checkbox"
          checked={attachScreenshot}
          onChange={(e) => onToggleAttachScreenshot(e.target.checked)}
        />
        Joindre une capture de l'élément
      </label>

      {screenshot && !screenshotSent && (
        <ScreenshotAnnotator
          key={screenshot.dataUrl}
          screenshot={screenshot}
          annotations={annotations}
          onAnnotate={onAnnotate}
          onRemove={onRemoveScreenshot}
        />
      )}

      {screenshot && screenshotSent && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CaptureThumbnail screenshot={screenshot} marks={annotations.present} />
          <div style={{ fontSize: 11, color: '#666' }}>
            <div>
              {screenshot.width}×{screenshot.height}px
            </div>
            <div>Envoyée avec le run</div>
          </div>
        </div>
      )}

      {!screenshot && screenshotDismissed && (
        <p style={{ fontSize: 12, marginTop: 8 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onRetakeScreenshot();
            }}
          >
            Reprendre la capture
          </a>
        </p>
      )}

      <button style={{ marginTop: 8 }} disabled={!canSend} onClick={submit}>
        {sendLabel}
      </button>

      <div style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 10 }}>
        <strong style={{ fontSize: 13 }}>Historique</strong>

        {undoNotice && <p style={{ fontSize: 12, color: '#1f6b2c', marginTop: 6 }}>{undoNotice}</p>}
        {error && <p style={{ fontSize: 12, color: '#a83232', marginTop: 6 }}>{error}</p>}

        {sortedRuns.length === 0 ? (
          <p style={{ fontSize: 12, color: '#666', marginTop: 6 }}>Aucun run enregistré.</p>
        ) : (
          sortedRuns.map((run) => (
            <div key={run.id} style={{ marginTop: 8, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  <strong>{run.agent}</strong> — {truncate(run.prompt, PROMPT_PREVIEW_LIMIT)}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 4,
                    flex: '0 0 auto',
                    background: run.status === 'accepted' ? '#dcf5e0' : '#eee',
                    color: run.status === 'accepted' ? '#1f6b2c' : '#666',
                  }}
                >
                  {run.status === 'accepted' ? 'accepté' : 'annulé'}
                </span>
              </div>
              <div style={{ color: '#666', marginTop: 2 }}>
                {run.files.length} fichier{run.files.length === 1 ? '' : 's'} · {formatDateTime(run.createdAt)}
              </div>
              {run.id === mostRecentAcceptedId && (
                <button style={{ marginTop: 4, fontSize: 12 }} onClick={() => onUndoRun(run.id)}>
                  Annuler ce run
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
