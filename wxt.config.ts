import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'watchtab',
    description: 'Auto-refresh any tab on a timer. Open source, no premium tier, no remote kill switch.',
    permissions: ['alarms', 'storage', 'tabs', 'notifications', 'windows', 'webRequest', 'webNavigation', 'offscreen'],
    // webRequest only delivers details for requests matching host_permissions.
    host_permissions: ['<all_urls>'],
  },
});
