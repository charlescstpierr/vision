import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Vizion',
    description: 'Modifie des sites web en direct avec un agent de code',
    permissions: ['sidePanel', 'activeTab', 'storage', 'scripting', 'tabs'],
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
    action: {
      default_title: 'Vizion',
    },
  },
});
