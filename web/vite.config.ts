import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8788';

export default defineConfig({
  // Keep Babel in sync with tests: Lingui 6.9 native transform leaves nested t macros unexpanded.
  plugins: [react(), lingui(), babel({ presets: [linguiTransformerBabelPreset()] }), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@server': fileURLToPath(new URL('../server/src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': apiProxyTarget, '/mcp': apiProxyTarget },
  },
});
