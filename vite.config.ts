import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React's documented Vite entry: https://react.dev/learn/build-a-react-app-from-scratch
export default defineConfig({
  root: 'apps/web',
  plugins: [react()],
  server: { proxy: { '/api': { target: process.env.IMSTAGE_API_TARGET || 'http://127.0.0.1:4419' } } },
  build: { outDir: '../../dist', emptyOutDir: true },
});
