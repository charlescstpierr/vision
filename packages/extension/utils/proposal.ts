import type { Override, OverrideProposal } from '@vizion/shared';

/**
 * Turns an agent's overlay-mode proposal into persistable overrides: each
 * proposed override gets a fresh id and the same `createdAt`, so the whole
 * batch lands as a single undo step (see `addOverrides`).
 */
export function proposalToOverrides(
  proposal: OverrideProposal[],
  now: number,
  idFactory: () => string,
): Override[] {
  return proposal.map((item) => ({ ...item, id: idFactory(), createdAt: now }));
}
