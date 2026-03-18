import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import federation from '@originjs/vite-plugin-federation'

export default defineConfig({
  plugins: [
    vue(),
    federation({
      name: 'ticketsPlugin',
      filename: 'remoteEntry.js',
      exposes: {
        './TicketsView': './src/TicketsView.vue',
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
