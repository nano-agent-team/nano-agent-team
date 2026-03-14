import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@originjs/vite-plugin-federation'

/**
 * Observability Feature — Module Federation REMOTE
 *
 * Exposes ObservabilityView as federation module.
 * Build output: frontend-dist/assets/remoteEntry.js
 */
export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'observabilityPlugin',
      filename: 'remoteEntry.js',
      exposes: {
        './ObservabilityView': './src/ObservabilityView.vue',
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
