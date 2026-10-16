import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const backend = `http://127.0.0.1:${process.env.MC_PORT ?? 4317}`;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // changeOrigin rewrites Host to the backend's loopback address so its DNS-rebinding guard passes.
    proxy: { '/api': { target: backend, changeOrigin: true } },
  },
});
