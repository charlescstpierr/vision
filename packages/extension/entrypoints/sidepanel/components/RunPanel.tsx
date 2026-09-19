import { useEffect, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import type { AgentKind } from '@vizion/shared';

type Props = {
  agents: AgentKind[];
  connected: boolean;
  elementSelected: boolean;
  running: boolean;
  prompt: string;
  setPrompt: (next: string) => void;
  promptRef?: RefObject<HTMLTextAreaElement>;
  onRun: (agent: AgentKind, prompt: string) => void;
};

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
  elementSelected,
  running,
  prompt,
  setPrompt,
  promptRef,
  onRun,
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
  const canSend = connected && elementSelected && agent !== '' && prompt.trim().length > 0 && !running;

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

      <button style={{ marginTop: 8 }} disabled={!canSend} onClick={submit}>
        Envoyer à l'agent
      </button>
    </div>
  );
}
