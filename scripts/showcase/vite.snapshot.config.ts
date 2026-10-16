/**
 * Showcase snapshot: a static build of the capture pages (showcase.html, audio.html) from the
 * tree as it is right now, so edits other agents make while a take renders cannot leak in.
 *   SNAP_OUT=<dir> npx vite build --config scripts/showcase/vite.snapshot.config.ts
 *   SNAP_OUT=<dir> SHOWCASE_PORT=5341 npx vite preview --config scripts/showcase/vite.snapshot.config.ts
 * (record.mjs / audio.mjs do both with --static <dir>.)
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = new URL('../../', import.meta.url).pathname
const outDir = process.env.SNAP_OUT ?? `${root}showcase-snapshot`
const port = Number(process.env.SHOWCASE_PORT ?? 5341)

export default defineConfig({
  root,
  base: '/',
  plugins: [react(), tailwindcss()],
  define: { __BUILD_ID__: JSON.stringify('showcase-snapshot') },
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 1 << 20,
    rollupOptions: {
      input: {
        showcase: `${root}src/render/showcase/showcase.html`,
        audio: `${root}src/render/showcase/audio.html`,
      },
    },
  },
  preview: { port, strictPort: true },
})
