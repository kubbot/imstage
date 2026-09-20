import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React's documented Vite entry: https://react.dev/learn/build-a-react-app-from-scratch
export default defineConfig({
  root: 'apps/web',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
});
