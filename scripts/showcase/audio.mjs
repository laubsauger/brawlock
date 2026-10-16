#!/usr/bin/env node
/**
 * Showcase soundtrack: renders the in-game audio (SFX, fight music, lava bed) offline for an
 * edit list, in sync with the recorded shots, in a headless muted Chrome.
 *   node scripts/showcase/audio.mjs --shots open,tip_move,... --out <file.wav> [--port 5343] [--mode synth|hybrid]
 *     [--static <snapshot dir>] [--mute-sfx]  (verification: SFX + UI buses at zero)
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const PORT = Number(opt('port', '5343'))
const OUT = resolve(opt('out', 'soundtrack.wav'))
const MODE = opt('mode', 'hybrid')
const MUTE_SFX = args.includes('--mute-sfx')
const ids = opt('shots', '').split(',').filter(Boolean)
const require = createRequire(import.meta.url)
const puppeteer = require(opt('puppeteer', '/Users/flo/work/code/wave-rider/node_modules/puppeteer'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const portOpen = (port) => new Promise((res) => {
  const s = net.connect({ port, host: 'localhost' }, () => { s.end(); res(true) })
  s.on('error', () => res(false))
})

if (await portOpen(PORT)) throw new Error(`port ${PORT} busy`)
const STATIC = opt('static', '')
const viteArgs = STATIC ? ['preview', '--config', 'scripts/showcase/vite.snapshot.config.ts'] : ['--config', 'scripts/showcase/vite.showcase.config.ts']
const vite = spawn(join(root, 'node_modules/.bin/vite'), viteArgs, { cwd: root, env: { ...process.env, SHOWCASE_PORT: String(PORT), ...(STATIC ? { SNAP_OUT: resolve(STATIC) } : {}) }, stdio: ['ignore', 'ignore', 'pipe'] })
let browser = null
try {
  for (let i = 0; i < 100 && !(await portOpen(PORT)); i++) await sleep(200)
  browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'], protocolTimeout: 1200000 })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.error('pageerror', e.message))
  page.on('console', (m) => { if (m.type() === 'error') console.error('console', m.text().slice(0, 300)) })
  await page.goto(`http://localhost:${PORT}/src/render/showcase/audio.html?mute`, { waitUntil: 'load' })
  for (let i = 0; i < 200 && !(await page.evaluate(() => !!window.__audio)); i++) await sleep(100)
  const t0 = Date.now()
  const info = await page.evaluate((e, m, mute) => window.__audio.render(e, m, mute), ids, MODE, MUTE_SFX)
  console.log(`rendered ${info.dur.toFixed(2)} s (${info.cues} frames) in ${((Date.now() - t0) / 1000).toFixed(1)} s; music started: ${info.musicStarted}${MUTE_SFX ? ' (SFX + UI buses muted)' : ''}`)
  const parts = []
  for (let i = 0; i < info.chunks; i++) parts.push(Buffer.from(await page.evaluate((k) => window.__audio.chunk(k), i), 'base64'))
  writeFileSync(OUT, Buffer.concat(parts))
  console.log(`wrote ${OUT}`)
} finally {
  if (browser) await browser.close().catch(() => {})
  vite.kill('SIGTERM')
}
