import { describe, expect, it } from 'vitest';
import { PAIRING_PAYLOAD_ELEMENT_ID, parsePairingPayload } from '@vizion/shared';
import { createPairingCode, escapeJsonForScriptTag, renderPairingPage } from './pairing.js';

const payload = { token: 'a'.repeat(32), port: 7331, cwd: '/home/u/proj', version: '0.1.0' };

describe('pairing', () => {
  it('creates a distinct, unguessable code each time', () => {
    const a = createPairingCode();
    const b = createPairingCode();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('escapes `<` so a value cannot close the script tag early', () => {
    const escaped = escapeJsonForScriptTag({ cwd: '</script><img src=x onerror=alert(1)>' });
    expect(escaped).not.toContain('</script>');
    expect(escaped).toContain('\\u003c');
    // Still valid JSON: the escape survives a round-trip.
    expect(JSON.parse(escaped)).toEqual({ cwd: '</script><img src=x onerror=alert(1)>' });
  });

  it('renders a page whose embedded payload parses back to the same values', () => {
    const html = renderPairingPage(payload);
    const match = new RegExp(`id="${PAIRING_PAYLOAD_ELEMENT_ID}">(.*?)</script>`, 's').exec(html);
    if (!match?.[1]) throw new Error('payload script tag not found');
    expect(parsePairingPayload(JSON.parse(match[1]))).toEqual(payload);
  });

  it('escapes a project path containing markup instead of rendering it', () => {
    const html = renderPairingPage({ ...payload, cwd: '/tmp/<script>bad</script>' });
    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
  });
});
