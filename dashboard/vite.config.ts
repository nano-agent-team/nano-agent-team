import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@originjs/vite-plugin-federation'
import path from 'path'

export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'coreDashboard',
      remotes: {
        // Runtime URL — served by core Express after plugin install
        // At build time this is just a placeholder; actual URL resolved at runtime
        devTeamPlugin: '/plugins/dev-team/assets/remoteEntry.js',
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
