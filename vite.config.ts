import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { netId } from './scripts/net-id.mjs'
import { resolveAssetBase } from './src/lib/assetBase'

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

// The sound board (src/audio/dev/soundboard.html) ships unlisted as /sounds.html.
const SOUNDS_ENTRY = 'src/audio/dev/soundboard.html'
function soundsPage(): Plugin {
  return {
    name: 'brawlock-sounds-page',
    // after vite's html plugin has emitted the page
    enforce: 'post',
    configureServer(server) {
      // dev: the production path redirects to the page (its relative script path stays valid)
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/sounds.html') return next()
        res.writeHead(302, { Location: `/${SOUNDS_ENTRY}${req.url.slice('/sounds.html'.length)}` })
        res.end()
      })
    },
    generateBundle(_opts, bundle) {
      for (const out of Object.values(bundle)) if (out.fileName === SOUNDS_ENTRY) out.fileName = 'sounds.html'
    },
  }
}

function hostedManifest(mediaBase: string): Plugin {
  return {
    name: 'brawlock-hosted-manifest',
    generateBundle() {
      const manifest = JSON.parse(readFileSync('public/brand/site.webmanifest', 'utf8'))
      for (const icon of manifest.icons) icon.src = new URL(icon.src, `${mediaBase}brand/`).href
      this.emitFile({ type: 'asset', fileName: 'brand/site.webmanifest', source: JSON.stringify(manifest) })
    },
  }
}

export default defineConfig(({ mode }) => {
  const appBase = process.env.GITHUB_ACTIONS && repo ? `/${repo}/` : '/'
  const configuredAssets = loadEnv(mode, process.cwd(), 'VITE_').VITE_ASSET_BASE_URL
  const mediaBase = resolveAssetBase(configuredAssets, appBase)
  return {
    base: appBase,
    experimental: {
      renderBuiltUrl(filename, { type }) {
        // Also handles splash/preload/CSS URLs before the application starts.
        // The install manifest stays on the game origin for its correct start URL.
        if (configuredAssets !== undefined && type === 'public' && filename !== 'brand/site.webmanifest') return mediaBase + filename
      },
    },
    plugins: [react(), tailwindcss(), versionFile(), soundsPage(), ...(configuredAssets === undefined ? [] : [hostedManifest(mediaBase)])],
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __NET_ID__: JSON.stringify(NET_ID) },
    resolve: {
      // bare 'three' (addons, r3f) and 'three/webgpu' (scene) would pull two
      // copies of three. Alias bare 'three' to the webgpu build so one instance
      // serves all. Skipped in tests: node has no WebGPU globals.
      alias: mode === 'test' ? [] : [{ find: /^three$/, replacement: 'three/webgpu' }],
    },
    build: {
      rollupOptions: { input: { main: 'index.html', sounds: SOUNDS_ENTRY } },
    },
    server: {
      // Explicit local opt-in. Production nginx proxies these same paths to the US authority.
      proxy: process.env.VITE_ACCOUNTS_ENABLED === 'true' ? {
        '/api/auth': { target: 'http://127.0.0.1:5352' },
        '/api/account': { target: 'http://127.0.0.1:5352' },
        '/api/progression': { target: 'http://127.0.0.1:5352' },
        '/api/presence': { target: 'http://127.0.0.1:5352' },
      } : undefined,
      port: process.env.PORT ? Number(process.env.PORT) : 5173,
      strictPort: false,
    },
    test: {
      include: ['src/**/*.test.ts'],
    },
  }
})
