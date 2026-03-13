import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@originjs/vite-plugin-federation'

/**
 * Settings Feature — Module Federation REMOTE
 *
 * Exposes SetupWizard and SettingsView as federation modules.
 * Core dashboard (host) imports them:
 *   - SetupWizard: shown in setup mode (first-run gate)
 *   - SettingsView: /settings route always available
 *
 * Build output: frontend-dist/assets/remoteEntry.js
 * Served by core Express at: /features/settings/assets/remoteEntry.js
 */
export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'settingsPlugin',
      filename: 'remoteEntry.js',
      exposes: {
        './SetupWizard': './src/SetupWizard.vue',
        './SettingsView': './src/SettingsView.vue',
      },
      shared: {
        vue: { singleton: true, requiredVersion: '^3.4.0' },
      } as any,
    }),
  ],
  build: {
    outDir: '../frontend-dist',
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: './src/entry.ts',
    },
  },
})
