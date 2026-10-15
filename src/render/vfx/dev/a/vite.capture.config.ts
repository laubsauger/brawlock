/**
 * Dev-only Vite config for headless VFX captures (workstream A): same build
 * setup as vite.config.ts, but no HMR and no file watching, so edits by
 * other workstreams never reload a page mid-capture. Restart it to pick up
 * new code.
 *   npx vite --config src/render/vfx/dev/a/vite.capture.config.ts
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: new URL('../../../../../', import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  server: { port: 5195, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
})
