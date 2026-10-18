// Render isolated snapshots through the game's current hybrid recipes for the listening review.
// Usage: node art/tools/render_audio_review.mjs <Vite origin> [output directory] [cues JSON]
// Puppeteer is supplied by the existing local tooling; no game code is changed.
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const puppeteer = require('/Users/flo/work/code/wave-rider/node_modules/puppeteer')
const origin = process.argv[2]
if (!origin) throw new Error('Pass the running Brawlock Vite origin')
const output = resolve(process.argv[3] ?? 'art/archive/audio-review/baselines')
await mkdir(output, { recursive: true })
const cues = process.argv[4] ? JSON.parse(await readFile(process.argv[4], 'utf8')) : [
  ['scourgeBlast', 1], ['gravityCast', 1], ['teleportOut', 1],
  ['shieldUp', 1], ['snowBurst', 1], ['fireballCast', 1],
  ['meteorImpact', 1], ['beamZap', 1], ['pillarRise', 1],
  ['uiClick', 1], ['buyNew', 1],
]
const browser = await puppeteer.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(origin + '/src/audio/dev/soundboard.html', { waitUntil: 'networkidle0' })
  const results = await page.evaluate(async (cues) => {
    const { RECIPES, Voice } = await import('/src/audio/synth.ts')
    const { VOICES, buildGraph, playLayer } = await import('/src/audio/engine.ts')
    const { HYBRID } = await import('/src/audio/hybrid.ts')
    const { AUDIO_ASSETS } = await import('/src/audio/assets.ts')
    const files = []
    const originalRandom = Math.random
    let seed = 271828
    const seeded = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296 }
    const decoded = new Map()
    for (const [id, param] of cues) {
      if (!RECIPES[id] || !VOICES[id]) throw new Error('Unknown recipe: ' + id)
      const ctx = new OfflineAudioContext(1, 6 * 48000, 48000)
      const graph = buildGraph(ctx)
      graph.master.gain.value = 0.8
      graph.sfx.gain.value = 1
      graph.ui.gain.value = 1
      const hybrid = HYBRID[id]
      for (const layer of hybrid?.layers ?? []) {
        for (const asset of layer.assets) {
          if (decoded.has(asset)) continue
          const response = await fetch('/audio/' + asset + '.ogg')
          if (!response.ok) throw new Error('Missing sample: ' + asset)
          decoded.set(asset, await ctx.decodeAudioData(await response.arrayBuffer()))
        }
      }
      const out = ctx.createGain()
      out.gain.value = VOICES[id].level * (hybrid?.trim ?? 1)
      out.connect(graph[VOICES[id].bus])
      const recipeOut = ctx.createGain()
      recipeOut.gain.value = hybrid?.synth ?? 1
      recipeOut.connect(out)
      const voice = new Voice(graph.synth, recipeOut, 0.03, 0)
      Math.random = seeded
      try {
        RECIPES[id](voice, param)
        for (const layer of hybrid?.layers ?? []) {
          if (layer.minParam !== undefined && param < layer.minParam) continue
          const asset = layer.assets[0]
          playLayer(ctx, voice, out, layer, decoded.get(asset), AUDIO_ASSETS[asset].duration, 0.03, param)
        }
      } finally { Math.random = originalRandom }
      if (voice.stopAt > 5.8) throw new Error('Render would truncate ' + id)
      const rendered = await ctx.startRendering()
      const samples = rendered.getChannelData(0).subarray(0, Math.min(rendered.length, Math.ceil((voice.stopAt + 0.5) * 48000)))
      const buffer = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(buffer)
      const str = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)) }
      str(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); str(8, 'WAVEfmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, 48000, true); view.setUint32(28, 96000, true)
      view.setUint16(32, 2, true); view.setUint16(34, 16, true)
      str(36, 'data'); view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true)
      const bytes = new Uint8Array(buffer)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      files.push({ id, param, duration: samples.length / 48000, wav: btoa(binary) })
    }
    return files
  }, cues)
  for (const file of results) {
    await writeFile(resolve(output, file.id + '.wav'), Buffer.from(file.wav, 'base64'))
    console.log(file.id + ': ' + file.duration.toFixed(2) + 's')
  }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(), mode: 'hybrid', source: 'current working tree', cues: results.map(({ wav, ...metadata }) => metadata) }, null, 2))
} finally {
  await browser.close()
}
