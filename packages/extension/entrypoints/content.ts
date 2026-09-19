import { SelectorOverlay } from '../utils/selector-overlay.js';
import { OverrideApplier } from '../utils/override-applier.js';
import { handlePairingPage } from '../utils/pairing.js';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    console.log('Vizion content script loaded');
    new SelectorOverlay();
    void new OverrideApplier().start();
    // No-op on every page but the local server's `/pair`, which it picks the
    // connection details up from so the user never copies a token by hand.
    void handlePairingPage();
  },
});
