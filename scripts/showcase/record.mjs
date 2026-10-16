#!/usr/bin/env node
/**
 * Showcase recorder: renders shots frame by frame in a headless, muted Chrome
 * (WebGPU) on a virtual clock and pipes the frames into ffmpeg.
 *
 *   node scripts/showcase/record.mjs --shots all --out <dir>
 *   node scripts/showcase/record.mjs --shots spell_meteor,spell_link --out <dir> [--frames 30]
 *
 * Options:
 *   --shots a,b|all   shot ids (src/render/showcase/shots), default all
 *   --out <dir>       one <id>.mp4 per shot (+ <id>.json with timing / event log)
 *   --port 5341       vite port (a capture-only server is started unless --no-server)
 *   --ssaa 2          internal render scale (2 = 3840x2160 for a 1080p frame, downsampled 2:1)
 *   --w 1920 --h 1080 output size
 *   --crf 12          x264 quality of the per-shot intermediates
 *   --frames N        stop after N frames (tests)
 *   --stills t1,t2    also save PNG stills at these video seconds (<id>_<t>.png)
 *   --static <dir>    capture from a snapshot build (vite.snapshot.config.ts) instead of the dev server
 *   --puppeteer <path to the puppeteer package> (default: wave-rider's node_modules)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const flag = (name) => args.includes(`--${name}`)

const PORT = Number(opt('port', '5341'))
const OUT = resolve(opt('out', join(root, 'showcase-out')))
const SSAA = Number(opt('ssaa', '2'))
const W = Number(opt('w', '1920'))
const H = Number(opt('h', '1080'))
const CRF = opt('crf', '12')
const MAX_FRAMES = Number(opt('frames', '0'))
const STILLS = (opt('stills', '') || '').split(',').filter(Boolean).map(Number)
const FFMPEG = opt('ffmpeg', '/opt/homebrew/bin/ffmpeg')
const CHROME = opt('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const require = createRequire(import.meta.url)
const puppeteer = require(opt('puppeteer', '/Users/flo/work/code/wave-rider/node_modules/puppeteer'))

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: 'localhost' }, () => {
      s.end()
      res(true)
    })
    s.on('error', () => res(false))
  })
}

async function startServer() {
  if (flag('no-server')) return null
  if (await portOpen(PORT)) throw new Error(`port ${PORT} is busy; pick another with --port or pass --no-server`)
  // --static <dir>: serve a frozen snapshot build (vite.snapshot.config.ts) instead of the live tree
  const STATIC = opt('static', '')
  const viteArgs = STATIC ? ['preview', '--config', 'scripts/showcase/vite.snapshot.config.ts'] : ['--config', 'scripts/showcase/vite.showcase.config.ts']
  const vite = spawn(join(root, 'node_modules/.bin/vite'), viteArgs, {
    cwd: root,
    env: { ...process.env, SHOWCASE_PORT: String(PORT), ...(STATIC ? { SNAP_OUT: resolve(STATIC) } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stdout.on('data', () => {})
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
  for (let i = 0; i < 100; i++) {
    if (await portOpen(PORT)) return vite
    await sleep(200)
  }
  vite.kill()
  throw new Error('vite did not come up')
}

function encoder(file) {
  const ff = spawn(
    FFMPEG,
    ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '60', '-c:v', 'png', '-i', '-', '-vf', `scale=${W}:${H}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`)))))
  return {
    async write(buf) {
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    },
    async end() {
      ff.stdin.end()
      await done
    },
  }
}

async function recordShot(browser, id) {
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
  const logs = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
  const url = `http://localhost:${PORT}/src/render/showcase/showcase.html?mute&shot=${encodeURIComponent(id)}&ssaa=${SSAA}`
  await page.goto(url, { waitUntil: 'load', timeout: 120000 })
  const t0 = Date.now()
  for (;;) {
    const ok = await page.evaluate(() => !!window.__showcase && window.__showcase.ready()).catch(() => false)
    if (ok) break
    if (Date.now() - t0 > 90000) {
      const st = await page.evaluate(() => window.__showcase && window.__showcase.status()).catch((e) => String(e))
      throw new Error(`shot ${id} never became ready: ${JSON.stringify(st)}\n${logs.join('\n')}`)
    }
    await sleep(250)
  }
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {})
  // real-time warm-up: shaders compile, textures upload, the scene settles
  await sleep(2500)
  const info = await page.evaluate(() => window.__showcase.info())
  const client = await page.createCDPSession()
  await page.evaluate(() => window.__showcase.begin())
  const file = join(OUT, `${id}.mp4`)
  const enc = encoder(file)
  const n = MAX_FRAMES > 0 ? Math.min(MAX_FRAMES, info.frames) : info.frames
  const stillFrames = new Map(STILLS.map((t) => [Math.max(1, Math.round(t * 60)), t]))
  const tStart = Date.now()
  let tShot = 0
  for (let i = 1; i <= n; i++) {
    await page.evaluate(() => window.__showcase.frame())
    if (i === 1 || i % 30 === 0) {
      const bad = await page.evaluate(() => window.__showcase.audit())
      if (bad.length > 0) throw new Error(`shot ${id} frame ${i}: non-designed overlay on screen (debug/perf UI?):\n  ${bad.join('\n  ')}`)
    }
    const t1 = Date.now()
    const shot = await client.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false, fromSurface: true })
    tShot += Date.now() - t1
    const buf = Buffer.from(shot.data, 'base64')
    await enc.write(buf)
    if (stillFrames.has(i)) writeFileSync(join(OUT, `${id}_${stillFrames.get(i)}.png`), buf)
    if (i % 60 === 0) process.stdout.write(`  ${id}: ${i}/${n} frames (${((Date.now() - tStart) / i).toFixed(0)} ms/frame, shot ${(tShot / i).toFixed(0)} ms)\n`)
  }
  await enc.end()
  const log = await page.evaluate(() => window.__showcase.log())
  const errors = await page.evaluate(() => window.__showcase.errors())
  writeFileSync(join(OUT, `${id}.json`), JSON.stringify({ id, info, frames: n, msPerFrame: (Date.now() - tStart) / n, errors, logs: logs.slice(0, 40), events: log }, null, 1))
  await page.close()
  return { id, frames: n, ms: Date.now() - tStart, errors, logs }
}

const server = await startServer()
let browser = null
try {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    args: ['--mute-audio', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=user-gesture-required'],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
    protocolTimeout: 600000,
  })
  let ids = (opt('shots', 'all') || 'all').split(',')
  if (ids.length === 1 && ids[0] === 'all') {
    const p = await browser.newPage()
    await p.goto(`http://localhost:${PORT}/src/render/showcase/showcase.html?mute&shot=test`, { waitUntil: 'load' })
    for (let i = 0; i < 200 && !(await p.evaluate(() => !!window.__showcase).catch(() => false)); i++) await sleep(100)
    ids = (await p.evaluate(() => window.__showcase.shots())).map((s) => s.id).filter((s) => s !== 'test')
    await p.close()
  }
  for (const id of ids) {
    const t = Date.now()
    process.stdout.write(`shot ${id}\n`)
    const r = await recordShot(browser, id)
    process.stdout.write(`  done ${id}: ${r.frames} frames in ${((Date.now() - t) / 1000).toFixed(1)} s${r.errors.length ? ` ERRORS ${r.errors.length}` : ''}\n`)
    if (r.errors.length) process.stdout.write(r.errors.join('\n') + '\n')
  }
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server) server.kill('SIGTERM')
}
