import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// OMNICEE frontend — dev server proxies /api and /socket.io to the Node
// backend (index.js + api/server.js run together via start-all.js) so the
// dashboard can hit relative paths in both dev and production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3001', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
