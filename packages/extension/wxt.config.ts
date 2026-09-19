import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Vizion',
    description: 'Modifie des sites web en direct avec un agent de code',
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs'],
    // '<all_urls>' is needed for chrome.tabs.captureVisibleTab to read the
    // page pixels when attaching an element screenshot to a run.
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*', '<all_urls>'],
    action: {
      default_title: 'Vizion',
    },
  },
});
