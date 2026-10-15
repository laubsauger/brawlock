/**
 * Dev-only Vite config for the showcase capture: same build setup as vite.config.ts, but
 * no HMR and no file watching (edits by other workstreams never reload a page mid-take;
 * restart the server, which record.mjs does per run, to pick up new code).
 *   npx vite --config scripts/showcase/vite.showcase.config.ts
 *   -> http://localhost:5341/src/render/showcase/showcase.html?mute&shot=<id>
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: new URL('../../', import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  define: { __BUILD_ID__: JSON.stringify('showcase') },
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  server: { port: Number(process.env.SHOWCASE_PORT ?? 5341), strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
})
