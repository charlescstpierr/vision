import type { ElementContext, Override } from '@vizion/shared';
import { describeChanges, describeTextChange, type StyleChange } from '../../../utils/change-to-prompt.js';
import { addOverride } from '../../../utils/override-store.js';

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type Params = {
  sourceMode: boolean;
  tabUrl: string | undefined;
  prompt: string;
  setPrompt: (next: string) => void;
  focusPrompt: () => void;
};

/**
 * Decides what a quick-style application or a committed text edit turns
 * into, per docs/PLAN.md 5 (milestone 6): in source mode (server connected
 * to a local page) it appends a plain-language description to the prompt
 * and focuses it, so the user can review/send it to the agent; in overlay
 * mode it persists the change directly as an override for the current tab's
 * URL.
 */
export function useApplyChange({ sourceMode, tabUrl, prompt, setPrompt, focusPrompt }: Params) {
  const appendToPrompt = (description: string) => {
    setPrompt(prompt.trim().length > 0 ? `${prompt}\n${description}` : description);
    focusPrompt();
  };

  const applyStyleChanges = (element: ElementContext, changes: StyleChange[]) => {
    if (sourceMode) {
      appendToPrompt(describeChanges(element, changes));
      return;
    }
    if (!tabUrl) return;
    for (const change of changes) {
      const override: Override = {
        id: makeId(),
        selector: element.selector,
        kind: 'style',
        property: change.property,
        value: change.value,
        createdAt: Date.now(),
      };
      void addOverride(tabUrl, override);
    }
  };

  const applyTextEdit = (selector: string, before: string, after: string) => {
    if (sourceMode) {
      appendToPrompt(describeTextChange(before, after));
      return;
    }
    if (!tabUrl) return;
    const override: Override = {
      id: makeId(),
      selector,
      kind: 'text',
      value: after,
      createdAt: Date.now(),
    };
    void addOverride(tabUrl, override);
  };

  return { applyStyleChanges, applyTextEdit };
}
