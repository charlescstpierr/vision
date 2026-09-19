import { SelectorOverlay } from '../utils/selector-overlay.js';
import { OverrideApplier } from '../utils/override-applier.js';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    console.log('Vizion content script loaded');
    new SelectorOverlay();
    void new OverrideApplier().start();
  },
});
