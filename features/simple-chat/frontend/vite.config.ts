import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@originjs/vite-plugin-federation'

/**
 * Simple Chat Feature — Module Federation REMOTE
 *
 * Exposes SimpleChatView as a federation module.
 * Core dashboard (host) imports it at the /chat route.
 *
 * Build output: frontend-dist/assets/remoteEntry.js
 * Served by core Express at: /features/simple-chat/assets/remoteEntry.js
 */
export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'simpleChatPlugin',
      filename: 'remoteEntry.js',
      exposes: {
        './SimpleChatView': './src/SimpleChatView.vue',
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
