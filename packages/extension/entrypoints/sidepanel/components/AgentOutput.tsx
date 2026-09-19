import { useEffect, useRef } from 'react';
import type { AgentEvent } from '@vizion/shared';

type Props = {
  events: AgentEvent[];
};

export default function AgentOutput({ events }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  if (events.length === 0) return null;

  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid #ddd',
        borderRadius: 8,
        padding: 10,
        maxHeight: 240,
        overflowY: 'auto',
        fontSize: 13,
      }}
    >
      {events.map((event, i) => (
        <div key={i} style={{ marginBottom: 6 }}>
          {event.type === 'started' && <p style={{ color: '#666', margin: 0 }}>Agent démarré</p>}
          {event.type === 'text' &&
            event.text.split('\n').map((line, j) => (
              <p key={j} style={{ margin: '2px 0' }}>
                {line}
              </p>
            ))}
          {event.type === 'tool' && (
            <p
              style={{
                margin: '2px 0',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12,
                color: '#3346a8',
              }}
            >
              ▸ {event.name}
              {event.detail ? ` ${event.detail}` : ''}
            </p>
          )}
          {event.type === 'done' && (
            <p style={{ margin: '2px 0', color: '#2f7a3d' }}>Terminé (code {event.exitCode})</p>
          )}
          {event.type === 'error' && (
            <p style={{ margin: '2px 0', color: '#a83232' }}>{event.message}</p>
          )}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
