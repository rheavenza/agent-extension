import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'SNOW → Splunk Agent',
    description:
      'Chat agent that reads your open ServiceNow tickets and searches your open Splunk tab using your existing sessions.',
    permissions: ['sidePanel', 'tabs', 'scripting', 'storage', 'unlimitedStorage'],
    // Granted at runtime from the Settings page, only for the origins you configure.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: 'Open SNOW → Splunk Agent' },
  },
});
