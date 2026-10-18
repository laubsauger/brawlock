/**
 * Sound board (dev page, also shipped unlisted as /sounds.html): every sound in the game,
 * playable on the real engine at in-game levels. The list comes from the registries
 * (board.ts), so new sounds appear without touching this page. Recordings load on demand,
 * the first time something needs them.
 *
 * `?vol=0` starts with the master at zero (muted screenshots).
 */
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AudioEngine, type AudioMode } from '../engine'
import type { AssetId } from '../assets'
import { buildBoard, type BoardItem } from './board'

const engine = new AudioEngine()
engine.autoLoadSamples = false
const BASE = import.meta.env.BASE_URL

const initialVolume = (() => {
  const v = Number(new URLSearchParams(location.search).get('vol'))
  return Number.isFinite(v) && new URLSearchParams(location.search).has('vol') ? Math.max(0, Math.min(1, v)) : 0.8
})()

/** Unlock (the first click) and wait until the context runs. */
async function ready() {
  engine.unlock()
  const g = engine.graph
  if (!g) return null
  if (g.ctx.state !== 'running') await (g.ctx as AudioContext).resume().catch(() => undefined)
  return g
}

async function load(ids: readonly AssetId[]) {
  const g = engine.graph
  if (g && ids.length) await engine.samples.loadIds(g.ctx, BASE, ids)
}

// --- level meter: one analyser on the output; the row that played last shows it ---------
const meterEls = new Map<string, { bar: HTMLDivElement; text: HTMLSpanElement; peak: number }>()
let analyser: AnalyserNode | null = null
let activeKey: string | null = null

function meterFor(key: string) {
  activeKey = key
  const m = meterEls.get(key)
  if (m) m.peak = -Infinity
  const g = engine.graph
  if (!g || analyser) return
  analyser = g.ctx.createAnalyser()
  analyser.fftSize = 2048
  g.output.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)
  const tick = () => {
    analyser!.getFloatTimeDomainData(buf)
    let peak = 0
    for (const s of buf) peak = Math.max(peak, Math.abs(s))
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity
    const row = activeKey ? meterEls.get(activeKey) : undefined
    if (row && db > row.peak) {
      row.peak = db
      row.bar.style.width = `${Math.max(0, Math.min(100, ((db + 48) / 48) * 100))}%`
      row.text.textContent = `peak ${db.toFixed(1)} dBFS`
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// --- playback ----------------------------------------------------------------------------
const sources = new Map<string, AudioBufferSourceNode>()
const loopTimers = new Map<string, ReturnType<typeof setTimeout>>()

function stopKey(key: string) {
  sources.get(key)?.stop()
  sources.delete(key)
  clearTimeout(loopTimers.get(key))
  loopTimers.delete(key)
}

async function playFile(key: string, id: AssetId, bus: 'master' | 'announcer', loop: boolean, onEnd: () => void) {
  const g = await ready()
  if (!g) return
  await load([id])
  const buffer = engine.samples.get(id)
  if (!buffer) return onEnd()
  stopKey(key)
  meterFor(key)
  const src = g.ctx.createBufferSource()
  src.buffer = buffer
  src.loop = loop
  src.connect(bus === 'master' ? g.master : g.announcer)
  src.onended = () => {
    if (sources.get(key) === src) sources.delete(key)
    onEnd()
  }
  sources.set(key, src)
  src.start()
}

async function playRecipe(item: Extract<BoardItem, { kind: 'recipe' }>, param: number | undefined, mode: AudioMode, loop: () => boolean) {
  const g = await ready()
  if (!g) return
  if (mode === 'hybrid') await load(item.hybrid)
  meterFor(item.key)
  engine.play({ id: item.id, gain: 1, pan: 0, param })
  // a loop toggle on a timed loop (travel, hold): play it again when it ends
  if (item.param?.seconds && param !== undefined && loop()) {
    clearTimeout(loopTimers.get(item.key))
    loopTimers.set(
      item.key,
      setTimeout(() => {
        if (loop()) void playRecipe(item, param, mode, loop)
      }, param * 1000),
    )
  }
}

// --- UI ----------------------------------------------------------------------------------
function Meter({ id }: { id: string }) {
  const bar = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (bar.current && text.current) meterEls.set(id, { bar: bar.current, text: text.current, peak: -Infinity })
    return () => void meterEls.delete(id)
  }, [id])
  return (
    <div>
      <div className="meter">
        <div ref={bar} />
      </div>
      <span ref={text} className="meterText">
        not played
      </span>
    </div>
  )
}

function Row({ item, mode, stopToken }: { item: BoardItem; mode: AudioMode; stopToken: number }) {
  const [param, setParam] = useState(item.kind === 'recipe' ? item.param?.value : undefined)
  const [loop, setLoop] = useState(false)
  const [on, setOn] = useState(false)
  const loopRef = useRef(loop)
  loopRef.current = loop
  useEffect(() => {
    setOn(false)
    setLoop(false)
  }, [stopToken])

  const play = () => {
    switch (item.kind) {
      case 'recipe':
        void playRecipe(item, param, mode, () => loopRef.current)
        break
      case 'sample':
        if (on && item.loop) {
          stopKey(item.key)
          setOn(false)
          break
        }
        setOn(true)
        void playFile(item.key, item.id, 'master', item.loop && loop, () => setOn(false))
        break
      case 'announcer':
        if (item.asset) void playFile(item.key, item.asset, 'announcer', false, () => undefined)
        break
      case 'ambience':
        void ready().then(async () => {
          meterFor(item.key)
          if (on) engine.ambience(null)
          else {
            engine.ambience(item.id)
            if (mode === 'hybrid') await load(item.beds)
          }
          setOn(!on)
        })
        break
      case 'music':
        void ready().then(() => {
          meterFor(item.key)
          engine.music(on ? 'none' : item.id)
          setOn(!on)
        })
        break
    }
  }

  const toggles = item.kind === 'ambience' || item.kind === 'music' || (item.kind === 'sample' && item.loop)
  const canLoop = (item.kind === 'sample' && item.loop) || (item.kind === 'recipe' && !!item.param?.seconds)
  return (
    <div className="row">
      <button onClick={play} aria-pressed={toggles ? on : undefined} disabled={item.kind === 'announcer' && !item.asset}>
        {toggles && on ? 'Stop' : 'Play'}
      </button>
      <div>
        <div className="name">{item.label}</div>
        <Info item={item} />
      </div>
      <div className="controls">
        {item.kind === 'recipe' && item.param && (
          <label className="meta">
            {item.param.label}{' '}
            <input
              type="number"
              min={item.param.min}
              max={item.param.max}
              step={item.param.step}
              value={param}
              onChange={(e) => setParam(Number(e.target.value))}
            />
          </label>
        )}
        {canLoop && (
          <button
            aria-pressed={loop}
            onClick={() => {
              setLoop(!loop)
              const src = sources.get(item.key)
              if (src) src.loop = !loop // a recording that is playing keeps going (or ends) in place
              else if (loop) stopKey(item.key) // a timed recipe loop stops re-triggering
            }}
          >
            Loop
          </button>
        )}
      </div>
      <Meter id={item.key} />
    </div>
  )
}

function Info({ item }: { item: BoardItem }) {
  switch (item.kind) {
    case 'recipe':
      return (
        <div className="meta">
          {item.bus} bus, level {item.level}
          {item.hybrid.length ? ` · hybrid: ${item.hybrid.join(', ')}` : ' · synth only'}
        </div>
      )
    case 'sample':
      return (
        <div className="meta">
          {item.file} · {item.duration.toFixed(2)} s{item.loop ? ' loop' : ''}
          {item.credit && ` · "${item.credit.title}" by ${item.credit.creator} (${item.credit.license})`}
          {item.usedBy.length ? ` · used by ${item.usedBy.join(', ')}` : ' · not layered into any recipe'}
        </div>
      )
    case 'announcer':
      return (
        <div className="meta">
          {item.asset ? `audio/${item.asset}.ogg` : 'no file'}
          {item.note && <span className="note"> · {item.note}</span>}
        </div>
      )
    case 'ambience':
      return <div className="meta">procedural bed{item.beds.length ? `; hybrid adds ${item.beds.join(', ')}` : ''}</div>
    case 'music':
      return <div className="meta">generative track (the lava bed follows it, as in game)</div>
  }
}

function Board() {
  const groups = useMemo(buildBoard, [])
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<AudioMode>('hybrid')
  const [volume, setVolume] = useState(initialVolume)
  const [stopToken, setStopToken] = useState(0)
  useEffect(() => {
    engine.setVolumes({ master: volume, sfx: 1, music: 0.6, ambience: 1, announcer: 0.8, muted: volume === 0 })
  }, [volume])
  useEffect(() => engine.setMode(mode), [mode])
  const q = query.trim().toLowerCase()
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  return (
    <>
      <header>
        <h1>Sound board</h1>
        <input type="search" placeholder={`Search ${total} sounds`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search sounds" />
        <span role="group" aria-label="Mode">
          <button aria-pressed={mode === 'synth'} onClick={() => setMode('synth')}>
            Synth
          </button>{' '}
          <button aria-pressed={mode === 'hybrid'} onClick={() => setMode('hybrid')}>
            Hybrid
          </button>
        </span>
        <label>
          Master
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Master volume" />
          {Math.round(volume * 100)}%
        </label>
        <button
          onClick={() => {
            engine.stopAll()
            for (const key of [...sources.keys(), ...loopTimers.keys()]) stopKey(key)
            setStopToken((n) => n + 1)
          }}
        >
          Stop all
        </button>
      </header>
      <main>
        {groups.map((g) => {
          const items = q ? g.items.filter((i) => i.search.includes(q) || g.title.toLowerCase().includes(q)) : g.items
          if (items.length === 0) return null
          return (
            <section key={g.title}>
              <h2>
                {g.title} ({items.length})
              </h2>
              {items.map((item) => (
                <Row key={item.key} item={item} mode={mode} stopToken={stopToken} />
              ))}
            </section>
          )
        })}
      </main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Board />
  </StrictMode>,
)
