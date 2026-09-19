import { describe, expect, it } from 'vitest';
import type { OverrideProposal } from '@vizion/shared';
import { proposalToOverrides } from './proposal.js';

describe('proposalToOverrides', () => {
  it('assigns a unique id and the given createdAt to each override, preserving other fields', () => {
    const proposal: OverrideProposal[] = [
      { selector: '#hero', kind: 'style', property: 'color', value: 'red' },
      { selector: '#title', kind: 'text', value: 'Bonjour' },
    ];
    let counter = 0;
    const overrides = proposalToOverrides(proposal, 123, () => `id-${counter++}`);

    expect(overrides).toEqual([
      { selector: '#hero', kind: 'style', property: 'color', value: 'red', id: 'id-0', createdAt: 123 },
      { selector: '#title', kind: 'text', value: 'Bonjour', id: 'id-1', createdAt: 123 },
    ]);
    const ids = overrides.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns an empty array for an empty proposal', () => {
    expect(proposalToOverrides([], 1, () => 'x')).toEqual([]);
  });
});
