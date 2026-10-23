import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The CSP allows only same-origin fonts and images, so nothing is inlined as a data: URL.
  build: { assetsInlineLimit: 0 },
  server: {
    proxy: {
      '/api': {
        target: process.env.GUILDD_URL ?? 'http://localhost:8787',
        ws: true,
        rewrite: (p) => p.slice(4),
      },
    },
  },
})
