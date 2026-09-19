import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, type ClientMessage } from './index.js';

describe('shared', () => {
  it('exposes the default port', () => {
    expect(DEFAULT_PORT).toBe(7331);
  });

  it('accepts a valid ClientMessage shape', () => {
    const msg: ClientMessage = { type: 'ping' };
    expect(msg.type).toBe('ping');
  });
});
