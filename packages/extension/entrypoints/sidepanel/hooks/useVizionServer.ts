import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '@vizion/shared';
import type { VizionSettings } from './useSettings.js';

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
 * Connects to `ws://127.0.0.1:<settings.port>/ws?token=<settings.token>`,
 * and tears down/reconnects whenever `settings` changes (e.g. the user saves
 * a new port or token in the Réglages section).
 */
export function useVizionServer(settings: VizionSettings): VizionServerHandle {
  const [status, setStatus] = useState<ServerStatus>('connecting');
  const [hello, setHello] = useState<Hello | null>(null);

  // Only `wsRef` and `listenersRef` outlive a single run of the effect below:
  // `send` reaches for the socket from outside it, and subscribers are
  // registered independently of which connection is current.
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<(msg: ServerMessage) => void>());

  useEffect(() => {
    // Scoped to this run, not to the hook. Held in refs, these were shared
    // across runs, and `settings` always changes once -- `useSettings` starts
    // at its defaults and resolves `chrome.storage.local` asynchronously. So
    // React tore this effect down and set it back up in the same commit, with
    // `closed` flipping true then false in between. The doomed default-settings
    // socket's `close` then arrived *after* that, no longer recognised itself
    // as stale, and reconnected forever to the old URL on the shared timer --
    // flipping the panel to "disconnected" about a second after it had
    // connected, for good, with no way back but a reload.
    let closed = false;
    let backoff = MIN_BACKOFF_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: WebSocket | null = null;

    function connect(): void {
      if (closed) return;
      setStatus((prev) => (prev === 'connected' ? prev : 'connecting'));
      const url = `ws://127.0.0.1:${settings.port}/ws?token=${encodeURIComponent(settings.token)}`;
      const ws = new WebSocket(url);
      current = ws;
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (closed || current !== ws) return;
        backoff = MIN_BACKOFF_MS;
        setStatus('connected');
      });

      ws.addEventListener('message', (event) => {
        if (closed || current !== ws) return;
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
        // `current !== ws` means a newer socket has already replaced this one,
        // so this close is history: reporting it would clobber a live
        // connection's state.
        if (closed || current !== ws) return;
        setStatus('disconnected');
        setHello(null);
        const delay = backoff;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        timer = setTimeout(connect, delay);
      };

      ws.addEventListener('close', scheduleReconnect);
      ws.addEventListener('error', () => {
        ws.close();
      });
    }

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      const socket = current;
      current = null;
      socket?.close();
      // Only drop the shared ref if it is still ours: a newer run of this
      // effect may already have put its own socket there.
      if (wsRef.current === socket) wsRef.current = null;
    };
  }, [settings.port, settings.token]);

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
