import { describe, expect, it } from 'vitest';
import { OVERRIDES_STORAGE_PREFIX, overrideKey } from './overrides.js';

describe('overrideKey', () => {
  it('strips query and hash', () => {
    expect(overrideKey('https://example.com/app/page?foo=bar#section')).toBe('https://example.com/app/page');
  });

  it('keeps origin and pathname as-is with no query or hash', () => {
    expect(overrideKey('http://localhost:3000/dash')).toBe('http://localhost:3000/dash');
  });
});

describe('OVERRIDES_STORAGE_PREFIX', () => {
  it('is a stable, namespaced prefix', () => {
    expect(OVERRIDES_STORAGE_PREFIX).toBe('vizion:overrides:');
  });
});
