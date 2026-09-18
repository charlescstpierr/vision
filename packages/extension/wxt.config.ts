import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Vizion',
    description: 'Edit live websites with a coding agent',
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting'],
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
    action: {
      default_title: 'Vizion',
    },
  },
});
