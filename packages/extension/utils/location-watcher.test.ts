import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocationWatcher } from './location-watcher.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createLocationWatcher', () => {
  it('does not call onChange before start()', () => {
    const onChange = vi.fn();
    let href = 'https://example.com/a';
    createLocationWatcher(() => href, onChange, 500);

    href = 'https://example.com/b';
    vi.advanceTimersByTime(2000);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not fire while the key stays the same', () => {
    const onChange = vi.fn();
    const href = 'https://example.com/a';
    const watcher = createLocationWatcher(() => href, onChange, 500);

    watcher.start();
    vi.advanceTimersByTime(5000);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires onChange with the new key once, on the first tick after a change', () => {
    const onChange = vi.fn();
    let href = 'https://example.com/a';
    const watcher = createLocationWatcher(() => href, onChange, 500);

    watcher.start();
    href = 'https://example.com/b';

    vi.advanceTimersByTime(499);
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('https://example.com/b');

    vi.advanceTimersByTime(2000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('detects multiple sequential changes, once per change', () => {
    const onChange = vi.fn();
    let href = 'https://example.com/a';
    const watcher = createLocationWatcher(() => href, onChange, 500);

    watcher.start();

    href = 'https://example.com/b';
    vi.advanceTimersByTime(500);
    href = 'https://example.com/c';
    vi.advanceTimersByTime(500);

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('treats the href at start() time as the baseline, not the href at creation time', () => {
    const onChange = vi.fn();
    let href = 'https://example.com/a';
    const watcher = createLocationWatcher(() => href, onChange, 500);

    href = 'https://example.com/b';
    watcher.start();

    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stop() prevents further onChange calls', () => {
    const onChange = vi.fn();
    let href = 'https://example.com/a';
    const watcher = createLocationWatcher(() => href, onChange, 500);

    watcher.start();
    watcher.stop();
    href = 'https://example.com/b';
    vi.advanceTimersByTime(5000);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('start() is idempotent while already running', () => {
    const onChange = vi.fn();
    let href = 'https://example.com/a';
    const watcher = createLocationWatcher(() => href, onChange, 500);

    watcher.start();
    watcher.start();
    href = 'https://example.com/b';
    vi.advanceTimersByTime(500);

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
