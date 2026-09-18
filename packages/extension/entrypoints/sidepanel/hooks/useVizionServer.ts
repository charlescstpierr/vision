import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PORT } from '@vizion/shared';
import type { ClientMessage, ServerMessage } from '@vizion/shared';

export type ServerStatus = 'connecting' | 'connected' | 'disconnected';

export type Hello = { version: string; cwd: string; agents: import('@vizion/shared').AgentKind[] };

export interface VizionServerHandle {
  status: ServerStatus;
  hello: Hello | null;
  send(msg: ClientMessage): boolean;
  subscribe(fn: (msg: ServerMessage) => void): () => void;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;

/**
 * Owns a single WebSocket connection to the local Vizion server, reconnecting
 * with doubling backoff (1s -> 10s) for as long as the side panel is open.
 */
export function useVizionServer(): VizionServerHandle {
  const [status, setStatus] = useState<ServerStatus>('connecting');
  const [hello, setHello] = useState<Hello | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<(msg: ServerMessage) => void>());
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;

    function connect(): void {
      if (closedRef.current) return;
      setStatus((prev) => (prev === 'connected' ? prev : 'connecting'));
      const ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}/ws`);
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        backoffRef.current = MIN_BACKOFF_MS;
        setStatus('connected');
      });

      ws.addEventListener('message', (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === 'hello') {
          setHello({ version: message.version, cwd: message.cwd, agents: message.agents });
        }
        for (const listener of listenersRef.current) listener(message);
      });

      const scheduleReconnect = () => {
        if (closedRef.current) return;
        setStatus('disconnected');
        setHello(null);
        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
        timerRef.current = setTimeout(connect, delay);
      };

      ws.addEventListener('close', scheduleReconnect);
      ws.addEventListener('error', () => {
        ws.close();
      });
    }

    connect();

    return () => {
      closedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const send = useCallback((msg: ClientMessage): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  const subscribe = useCallback((fn: (msg: ServerMessage) => void): (() => void) => {
    listenersRef.current.add(fn);
    return () => listenersRef.current.delete(fn);
  }, []);

  return { status, hello, send, subscribe };
}
