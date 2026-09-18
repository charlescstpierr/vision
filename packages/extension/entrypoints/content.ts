export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    console.log('Vizion content script loaded');
  },
});
