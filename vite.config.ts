import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { netId } from './scripts/net-id.mjs'

// GitHub Pages serves the site under /<repo-name>/
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]

// Identifies a deploy. The running page compares it with /version.json to
// notice that a newer build replaced its lazily loaded chunks.
const BUILD_ID = process.env.GITHUB_SHA?.slice(0, 12) ?? `dev-${Date.now()}`

// Netcode compatibility id (scripts/net-id.mjs): a dedicated server refuses clients of
// another netcode. Release builds only; dev builds are never refused.
const NET_ID = process.env.GITHUB_SHA ? netId(process.cwd()) : `dev-${netId(process.cwd())}`

function versionFile(): Plugin {
  return {
    name: 'brawlock-version-file',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
    },
  }
}

export default defineConfig(({ mode }) => ({
  base: process.env.GITHUB_ACTIONS && repo ? `/${repo}/` : '/',
  plugins: [react(), tailwindcss(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __NET_ID__: JSON.stringify(NET_ID) },
  resolve: {
    // bare 'three' (addons, r3f) and 'three/webgpu' (scene) would pull two
    // copies of three. Alias bare 'three' to the webgpu build so one instance
    // serves all. Skipped in tests: node has no WebGPU globals.
    alias: mode === 'test' ? [] : [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
}) as Parameters<typeof defineConfig>[0])
