export default defineBackground(() => {
  console.log('Vizion background installed');

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error('Failed to set side panel behavior', err));
});
