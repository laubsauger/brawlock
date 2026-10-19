#!/usr/bin/env node
/**
 * Trailer title layer capture: renders src/render/showcase/titles.html frame by frame for a
 * title spec (written by trailer.mjs) in a headless, muted Chrome and encodes it with alpha.
 *   node scripts/showcase/titles.mjs --spec <titles.json> --out <titles.mov> [--port 5345]
 *     [--workers 6] [--chunk 120] [--frames N]
 * Output: PNG-in-MOV (lossless RGBA), 1920x1080 at 60 fps, the length of the spec.
 *
 * Fast path (the frame-range scheme of fframes, see ~/work/code/moe): the frames are cut into
 * chunks that several pages render in parallel, each chunk into its own all-intra segment,
 * joined at the end by stream copy. Within a page, a frame whose layer DOM is unchanged
 * reuses the previous capture.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const args = process.argv.slice(2)
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d
}
const SPEC = JSON.parse(readFileSync(resolve(opt('spec', 'titles.json')), 'utf8'))
const OUT = resolve(opt('out', 'titles.mov'))
const PORT = Number(opt('port', '5345'))
const WORKERS = Number(opt('workers', '6'))
const CHUNK = Number(opt('chunk', '120'))
const FPS = 60
const MAX = Number(opt('frames', '0'))
const FFMPEG = opt('ffmpeg', '/opt/homebrew/bin/ffmpeg')
const require = createRequire(import.meta.url)
const puppeteer = require(opt('puppeteer', '/Users/flo/work/code/wave-rider/node_modules/puppeteer'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: 'localhost' }, () => {
      s.end()
      res(true)
    })
    s.on('error', () => res(false))
  })

const frames = MAX > 0 ? MAX : Math.round(SPEC.dur * FPS)
const parts = join(dirname(OUT), `${OUT.split('/').pop()}.parts`)
rmSync(parts, { recursive: true, force: true })
mkdirSync(parts, { recursive: true })
const chunks = []
for (let a = 0; a < frames; a += CHUNK) chunks.push([a, Math.min(frames, a + CHUNK)])

if (await portOpen(PORT)) throw new Error(`port ${PORT} busy`)
const vite = spawn(join(root, 'node_modules/.bin/vite'), ['--config', 'scripts/showcase/vite.showcase.config.ts'], { cwd: root, env: { ...process.env, SHOWCASE_PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'pipe'] })
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
let browsers = []
try {
  for (let i = 0; i < 100 && !(await portOpen(PORT)); i++) await sleep(200)
  // one browser per worker: background tabs of one browser get no compositor frames
  const launch = () =>
    puppeteer.launch({
      headless: 'new',
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--mute-audio', '--force-color-profile=srgb', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
      defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
      protocolTimeout: 600000,
    })
  browsers = await Promise.all(Array.from({ length: Math.min(WORKERS, chunks.length) }, () => launch()))

  async function openPage(browser) {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await page.goto(`http://localhost:${PORT}/src/render/showcase/titles.html?mute`, { waitUntil: 'load', timeout: 120000 })
    for (let i = 0; i < 300 && !(await page.evaluate(() => !!window.__titles).catch(() => false)); i++) await sleep(100)
    await page.evaluate((s) => window.__titles.load(s), SPEC)
    for (let i = 0; i < 300 && !(await page.evaluate(() => window.__titles.ready())); i++) await sleep(100)
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 20000 }).catch(() => {})
    const client = await page.createCDPSession()
    await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    return { page, client }
  }

  async function renderChunk(w, k) {
    const [a, b] = chunks[k]
    const file = join(parts, `${String(k).padStart(4, '0')}.mov`)
    const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-c:v', 'png', '-pix_fmt', 'rgba', file], { stdio: ['pipe', 'inherit', 'inherit'] })
    const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c}`)))))
    const write = async (buf) => {
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    }
    let drawn = 0
    for (let i = a; i < b; i++) {
      const sig = await w.page.evaluate((t) => window.__titles.render(t), i / FPS)
      let buf = w.seen.get(sig)
      if (!buf) {
        const shot = await w.client.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false })
        buf = Buffer.from(shot.data, 'base64')
        if (w.seen.size > 200) w.seen.clear()
        w.seen.set(sig, buf)
        if (sig) drawn++
      }
      await write(buf)
    }
    ff.stdin.end()
    await done
    return drawn
  }

  const t0 = Date.now()
  let next = 0
  let drawn = 0
  let finished = 0
  const pages = await Promise.all(browsers.map((b) => openPage(b)))
  await Promise.all(
    pages.map(async (p) => {
      const w = { ...p, seen: new Map() }
      for (;;) {
        const k = next++
        if (k >= chunks.length) return
        const d = await renderChunk(w, k)
        drawn += d
        finished++
        if (finished % 5 === 0) process.stdout.write(`  titles: ${finished}/${chunks.length} chunks\n`)
      }
    }),
  )
  // join the all-intra segments without re-encoding
  const list = join(parts, 'list.txt')
  writeFileSync(list, chunks.map((_, k) => `file '${join(parts, `${String(k).padStart(4, '0')}.mov`)}'`).join('\n') + '\n')
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', OUT])
  rmSync(parts, { recursive: true, force: true })
  console.log(`titles: ${SPEC.events.length} events, ${frames} frames (${drawn} drawn) on ${pages.length} pages in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${OUT}`)
} finally {
  // a browser that does not close must not keep the process alive
  await Promise.race([Promise.all(browsers.map((b) => b.close().catch(() => {}))), sleep(5000)])
  for (const b of browsers) b.process()?.kill('SIGKILL')
  vite.kill('SIGTERM')
}
process.exit(0)
