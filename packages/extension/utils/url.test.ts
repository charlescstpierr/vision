import { describe, expect, it } from 'vitest';
import { isLocalUrl } from './url.js';

describe('isLocalUrl', () => {
  it('is true for localhost', () => {
    expect(isLocalUrl('http://localhost:3000/app')).toBe(true);
  });

  it('is true for 127.0.0.1', () => {
    expect(isLocalUrl('http://127.0.0.1:5173/')).toBe(true);
  });

  it('is true for the IPv6 loopback', () => {
    expect(isLocalUrl('http://[::1]:3000/')).toBe(true);
  });

  it('is true for a *.localhost subdomain', () => {
    expect(isLocalUrl('https://app.localhost/x')).toBe(true);
  });

  it('is false for a remote https host', () => {
    expect(isLocalUrl('https://example.com/')).toBe(false);
  });

  it('is false for a non-http(s) protocol', () => {
    expect(isLocalUrl('chrome-extension://abc/sidepanel.html')).toBe(false);
  });

  it('is false for undefined', () => {
    expect(isLocalUrl(undefined)).toBe(false);
  });

  it('is false for an unparsable URL', () => {
    expect(isLocalUrl('not a url')).toBe(false);
  });
});
