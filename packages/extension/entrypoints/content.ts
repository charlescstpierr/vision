import { SelectorOverlay } from '../utils/selector-overlay.js';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    console.log('Vizion content script loaded');
    new SelectorOverlay();
  },
});
