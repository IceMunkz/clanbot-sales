import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

/* Builds the ClanBot Platform app into the sales server's public dir, mirroring
   the bot repo's credential-ui → public/app convention. The server serves the
   shell at /clan and /join/<code>, and assets under /platform/. emptyOutDir is
   safe here — public/platform/ is fully generated, nothing hand-written. */
export default defineConfig({
  plugins: [react()],
  base: '/platform/',
  build: {
    outDir: path.resolve(__dirname, '../public/platform'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/auth': 'http://localhost:4000',
    },
  },
})
