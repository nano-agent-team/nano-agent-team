import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@originjs/vite-plugin-federation'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'coreDashboard',
      remotes: {
        // Runtime URLs — served by core Express
        // At build time these are just placeholders; actual URLs resolved at runtime
        devTeamPlugin: '/plugins/dev-team/assets/remoteEntry.js',
        settingsPlugin: '/features/settings/assets/remoteEntry.js',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      shared: {
        vue: { singleton: true, requiredVersion: '^3.4.0' },
        marked: { singleton: true },
      } as any,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/plugins': 'http://localhost:3001',
      '/features': 'http://localhost:3001',
      '/internal': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Module federation requires esnext
    target: 'esnext',
    minify: false,
  },
})
