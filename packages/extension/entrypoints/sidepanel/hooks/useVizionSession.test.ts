import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVizionServer, type VizionServerHandle } from './useVizionServer.js';

class TestSocket extends EventTarget {
  static OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  static instances: TestSocket[] = [];
  constructor(readonly url: string) {
    super();
    TestSocket.instances.push(this);
  }
  close() { this.readyState = 3; }
  send() {}
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  closed() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

describe('useVizionServer connection lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    TestSocket.instances = [];
    sessionStorage.clear();
  });

  it('ignores a delayed close from the socket replaced after saving settings', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', TestSocket);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    let handle: VizionServerHandle | undefined;
    function Panel({ token }: { token: string }) {
      handle = useVizionServer({ port: 7331, token });
      return null;
    }
    try {
      await act(async () => root.render(createElement(Panel, { token: 'old' })));
      const old = TestSocket.instances[0]!;
      await act(async () => old.open());
      await act(async () => root.render(createElement(Panel, { token: 'new' })));
      const current = TestSocket.instances[1]!;
      await act(async () => current.open());
      await act(async () => old.closed());
      expect(handle?.status).toBe('connected');
      await act(async () => vi.advanceTimersByTime(1000));
      expect(TestSocket.instances).toHaveLength(2);
      expect(handle?.send({ type: 'ping' })).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps the same session identifier when reconnecting after a dropped socket', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', TestSocket);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.createElement('div'));
    function Panel() {
      useVizionServer({ port: 7331, token: 'paired' });
      return null;
    }
    try {
      await act(async () => root.render(createElement(Panel)));
      const first = TestSocket.instances[0]!;
      const session = new URL(first.url).searchParams.get('session');
      expect(session).toBeTruthy();
      await act(async () => { first.open(); first.closed(); });
      await act(async () => vi.advanceTimersByTime(1000));
      expect(new URL(TestSocket.instances[1]!.url).searchParams.get('session')).toBe(session);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
