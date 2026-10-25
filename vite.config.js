import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The interface lives in client/ and is built into dist/, which server.js serves.
// `npm run dev` serves it with live reload, the API coming from `node server.js` on port 3000.
const api = 'http://localhost:3000';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    proxy: { '/api': api, '/icons.svg': api, '/manifest.webmanifest': api },
  },
});
