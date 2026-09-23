import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
// Compile the same SceneView used by the Web export; never run a dev server.
// https://vite.dev/guide/ssr#building-for-production
await build({
  configFile: false, root, plugins: [react()], logLevel: 'warn',
  build: {
    ssr: path.join(root, 'services/mcp/studio-entry.tsx'),
    outDir: path.join(root, '.local/mcp-renderer'), emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'studio.mjs' } },
  },
});
