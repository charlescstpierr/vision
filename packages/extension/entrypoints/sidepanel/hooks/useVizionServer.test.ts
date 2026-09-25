import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVizionServer, type VizionServerHandle } from './useVizionServer.js';

class FakeSocket extends EventTarget {
  static sockets: FakeSocket[] = [];
  readonly OPEN = 1;
  readyState = 0;
  readonly send = vi.fn();

  constructor(readonly url: string) {
    super();
    FakeSocket.sockets.push(this);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = this.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  closed(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

afterEach(() => {
  FakeSocket.sockets = [];
  vi.unstubAllGlobals();
});

describe('useVizionServer', () => {
  it('ignores a stale close after settings reconnect to a different socket', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const host = document.createElement('div');
    const root = createRoot(host);
    let server: VizionServerHandle | undefined;
    const Probe = ({ port }: { port: number }) => {
      server = useVizionServer({ port, token: 'paired' });
      return null;
    };
    try {
      await act(async () => { root.render(createElement(Probe, { port: 7331 })); });
      const old = FakeSocket.sockets[0]!;
      await act(async () => { root.render(createElement(Probe, { port: 7332 })); });
      const current = FakeSocket.sockets[1]!;
      await act(async () => { current.open(); });
      expect(server?.status).toBe('connected');

      // The retired socket's close event can arrive after the new one opens.
      await act(async () => { old.closed(); });
      expect(server?.status).toBe('connected');
      expect(server?.send({ type: 'ping' })).toBe(true);
      expect(FakeSocket.sockets).toHaveLength(2);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});
