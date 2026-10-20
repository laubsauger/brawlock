import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { audio } from '../../audio'
import { eventsSince, frame } from '../../game/frame'
import { inspectClick } from '../../game/input'
import { inspectStore } from '../../game/inspect'
import { REPLAY_SPEEDS, replayViewer, type ViewerView } from '../../game/replay/viewer'
import { TICK_HZ } from '../../sim'
import { announce, Killfeed } from '../hud/Announce'
import { FeedTally } from '../hud/killTags'
import { Scoreboard } from '../hud/Overlays'
import { InspectCard } from '../hud/Inspect'
import { AbilityCardHost, hideAbilityCard } from '../hud/AbilityCard'
import { TopCenter } from '../hud/TopBar'
import { exitReplay, exportReplay } from '../lib/replays'
import { isTypingTarget } from '../lib/keys'
import { useTick } from '../lib/ticker'
import { slotColor, slotGlyph, slotName } from '../lib/view'
import { setCameraFocus, zoomCamera } from '../renderBridge'
import { Button, Kbd } from '../widgets'

/** game units the free camera moves per second while a pan key is held */
const PAN_SPEED = 1400
/** game units per dragged pixel (free camera) */
const DRAG_UNITS = 2.2
const SKIP_SECONDS = 5

function clock(ticks: number): string {
  const s = Math.max(0, Math.round(ticks / TICK_HZ))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`
}

const subscribe = (cb: () => void) => replayViewer.subscribe(cb)
const snapshot = () => replayViewer.get()

/** Structural viewer state (load, play/pause, speed, camera); never per frame. */
function useViewer(): ViewerView {
  return useSyncExternalStore(subscribe, snapshot)
}

/**
 * Replay viewer: the match scene re-simulated from a local replay, with the score plate,
 * kill feed, loadout inspection, (Tab) scoreboard and playback controls. No gameplay commands.
 */
export function Replay() {
  const v = useViewer()

  // camera + sound sinks for the viewer while this screen is up
  useEffect(() => {
    inspectStore.reset()
    replayViewer.sinks = {
      cameraFocus: setCameraFocus,
      audio: (events, listener) => {
        try {
          audio.playEvents(events, listener)
        } catch {
          /* audio not ready */
        }
      },
    }
    return () => {
      inspectStore.reset()
      hideAbilityCard()
      replayViewer.sinks = {}
      setCameraFocus(null)
    }
  }, [])

  // kill feed from the replayed events (rewinds with seeks)
  const feed = useRef({ lastTick: -1, tally: new FeedTally() })
  useTick(() => {
    // until the replay is loaded the frame buffer still holds the match you came from
    if (replayViewer.get().status !== 'ready') {
      feed.current.lastTick = -1
      return
    }
    const state = frame.curr
    if (!state) return
    const f = feed.current
    if (state.tick < f.lastTick) {
      // a rewind: the feed starts over from here (streaks earned before it are not re-counted)
      f.lastTick = state.tick
      f.tally.reset()
      announce.clearFeed()
    }
    for (const batch of eventsSince(f.lastTick)) {
      f.lastTick = Math.max(f.lastTick, batch.tick)
      for (const e of batch.events) {
        if (e.type !== 'death') continue
        const tags = f.tally.death(e.owner, e.killer, batch.tick / TICK_HZ)
        const local = frame.localPlayer
        const victim = { name: slotName(state, e.owner), color: slotColor(state, e.owner), glyph: slotGlyph(state, e.owner) }
        const killer = e.killer != null && e.killer !== e.owner ? { name: slotName(state, e.killer), color: slotColor(state, e.killer), glyph: slotGlyph(state, e.killer) } : null
        const lava = e.cause === 'lava'
        announce.kill({ killer, victim, cause: lava || !e.cause ? null : e.cause, lava, local: e.owner === local || e.killer === local, myKill: !!killer && e.killer === local, tags })
      }
    }
  })

  // keyboard: Space play/pause, arrows skip, WASD pan (free camera), 0..9 follow, Esc exit
  const [scores, setScores] = useState(false)
  const held = useRef(new Set<string>())
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const view = replayViewer.get()
      const k = e.key.toLowerCase()
      if (k === ' ') {
        e.preventDefault()
        replayViewer.toggle()
      } else if (k === 'arrowleft' || k === 'arrowright') {
        e.preventDefault()
        const step = (e.shiftKey ? 6 : 1) * SKIP_SECONDS * TICK_HZ
        replayViewer.seek(replayViewer.tick() + (k === 'arrowleft' ? -step : step))
      } else if (k === 'escape') {
        if (inspectStore.get().inspect >= 0) inspectStore.set({ inspect: -1 })
        else exitReplay()
      }
      else if (k === 'tab') {
        e.preventDefault()
        setScores(true)
      } else if (k === '0') replayViewer.follow(-1)
      else if (/^[1-9]$/.test(k)) {
        const slot = view.slots[Number(k) - 1]
        if (slot) replayViewer.follow(slot.id)
      } else if ('wasd'.includes(k) && k.length === 1) held.current.add(k)
    }
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === 'tab') setScores(false)
      held.current.delete(k)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])
  const lastPan = useRef(0)
  useTick((now) => {
    const dt = lastPan.current ? Math.min(0.1, (now - lastPan.current) / 1000) : 0
    lastPan.current = now
    const h = held.current
    if (!h.size || replayViewer.get().follow >= 0) return
    const dx = (h.has('d') ? 1 : 0) - (h.has('a') ? 1 : 0)
    const dy = (h.has('w') ? 1 : 0) - (h.has('s') ? 1 : 0)
    if (dx || dy) replayViewer.pan(dx * PAN_SPEED * dt, dy * PAN_SPEED * dt)
  })

  // free camera: drag the scene; wheel zooms in every mode
  const drag = useRef<{ x: number; y: number; startX: number; startY: number; moved: boolean } | null>(null)

  // the timeline and clock move every frame: written straight to the DOM (no React state)
  const fill = useRef<HTMLDivElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const range = useRef<HTMLInputElement>(null)
  useTick(() => {
    const view = replayViewer.get()
    const t = replayViewer.tick()
    const span = Math.max(1, view.endTick - view.startTick)
    if (fill.current) fill.current.style.width = `${(((t - view.startTick) / span) * 100).toFixed(3)}%`
    if (time.current) time.current.textContent = `${clock(t - view.startTick)} / ${clock(view.endTick - view.startTick)}`
    if (range.current && document.activeElement !== range.current) range.current.value = String(t)
  })

  if (v.status === 'mismatch' || v.status === 'missing') {
    return (
      <div className="fade-in flex h-full items-center justify-center p-6">
        <div className="panel max-w-md p-6 text-center" role="alert">
          <h2 className="mb-2 text-[1.4rem] font-bold">{v.status === 'missing' ? 'Replay not found' : 'Made with an older version'}</h2>
          <p className="mb-5 text-ash">
            {v.status === 'missing'
              ? 'This replay is no longer in your library.'
              : 'This replay was recorded with a different version of Brawlock. The game has changed since, so it can no longer be played back.'}
          </p>
          <Button variant="primary" sound="back" onClick={exitReplay} autoFocus>
            Back
          </Button>
        </div>
      </div>
    )
  }

  const span = Math.max(1, v.endTick - v.startTick)
  const pct = (tick: number) => `${(((tick - v.startTick) / span) * 100).toFixed(3)}%`
  const name = (id: number | null) => v.slots.find((s) => s.id === id)?.name ?? 'the lava'
  const colorOf = (id: number | null) => {
    const sl = v.slots.find((s) => s.id === id)
    return sl ? hex(sl.color) : '#ff6a55'
  }

  return (
    <div
      className="fade-in relative h-full overflow-hidden"
      onWheel={(e) => zoomCamera(Math.sign(e.deltaY))}
      onPointerDown={(e) => {
        if (e.button === 0 && e.target === e.currentTarget && replayViewer.get().status === 'ready') {
          drag.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 5) d.moved = true
        if (d.moved && replayViewer.get().follow < 0) replayViewer.pan(-(e.clientX - d.x) * DRAG_UNITS, (e.clientY - d.y) * DRAG_UNITS)
        d.x = e.clientX
        d.y = e.clientY
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        if (d && !d.moved && replayViewer.get().status === 'ready') inspectClick(e.clientX, e.clientY, { follow: false })
      }}
      onPointerCancel={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* top: replay tag and exit (left), score plate (centre), kill feed (right) */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto flex items-center gap-1.5">
          <span className="replay-tag" aria-label="Replay">
            <i aria-hidden />
            Replay
          </span>
          <Button size="sm" variant="ghost" sound="back" onClick={exitReplay}>
            Exit <Kbd>Esc</Kbd>
          </Button>
          {v.id && (
            <Button size="sm" variant="ghost" onClick={() => void exportReplay(v.id!)} title="Save this replay as a file to share">
              Export
            </Button>
          )}
        </div>
        <TopCenter />
        <div className="w-72">
          <Killfeed />
        </div>
      </div>

      {v.desync && (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 rounded-md px-3 py-1.5 text-[0.95rem] text-[#ffb3a6]" style={{ background: 'rgba(40,0,0,.65)' }} role="status">
          Desync at {clock(v.desync.tick - v.startTick)}: from here the replay may differ from the real match.
        </div>
      )}
      {v.status === 'loading' && <div className="absolute inset-0 flex items-center justify-center text-ash">Loading replay…</div>}
      {v.status === 'ready' && <><InspectCard /><AbilityCardHost /></>}
      {scores && (
        <div>
          <Scoreboard onWatch={(player) => replayViewer.follow(player)} />
        </div>
      )}

      {/* bottom centre: timeline and playback controls (a fixed-size plate; the fill and clock move via refs) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
        <div className="replay-bar hud-plate pointer-events-auto flex w-[min(780px,100%)] flex-col gap-1.5 px-4 pt-2.5 pb-2">
          {/* timeline: round starts (notches) and knockouts (diamonds in the killer's colour) */}
          <div className="relative h-6">
            <div className="absolute inset-x-0 top-[10px] h-[4px] rounded-full bg-[rgba(255,255,255,.12)]" />
            <div ref={fill} className="absolute left-0 top-[10px] h-[4px] rounded-full bg-[#ffb36b] shadow-[0_0_8px_rgba(255,150,60,.6)]" style={{ width: pct(v.tick) }} />
            {v.rounds.map(([t, r]) => (
              <button
                key={`r${t}`}
                type="button"
                className="replay-mark-round absolute top-[2px] -translate-x-1/2"
                style={{ left: pct(t) }}
                title={`Round ${r} (${clock(t - v.startTick)})`}
                aria-label={`Jump to round ${r}`}
                onClick={() => replayViewer.seek(t)}
              >
                <span>{r}</span>
              </button>
            ))}
            {v.kills.map(([t, killer, victim], i) => (
              <button
                key={`k${t}-${i}`}
                type="button"
                className="replay-mark-kill absolute top-[7px] -translate-x-1/2"
                style={{ left: pct(t), ['--c' as string]: colorOf(killer ?? victim) }}
                title={`${name(killer)} knocked out ${name(victim)} (${clock(t - v.startTick)})`}
                aria-label={`Jump to ${name(victim)} going down`}
                onClick={() => replayViewer.seek(Math.max(v.startTick, t - 3 * TICK_HZ))}
              />
            ))}
            <input
              ref={range}
              type="range"
              className="absolute inset-x-0 top-[4px] h-4 w-full cursor-pointer opacity-0"
              min={v.startTick}
              max={v.endTick}
              defaultValue={v.tick}
              aria-label="Replay position"
              onChange={(e) => replayViewer.seek(Number(e.target.value))}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="primary" className="w-[4.2rem] px-0" onClick={() => replayViewer.toggle()} aria-label={v.playing ? 'Pause' : 'Play'} title="Play / pause (Space)">
              <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                {v.playing ? <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor" /> : <path d="M3 1.2l7.5 4.8L3 10.8z" fill="currentColor" />}
              </svg>
            </Button>
            <Button size="sm" variant="ghost" className="px-2" onClick={() => replayViewer.seek(replayViewer.tick() - SKIP_SECONDS * TICK_HZ)} aria-label="Back 5 seconds" title="Back 5 s (←)">
              −5 s
            </Button>
            <Button size="sm" variant="ghost" className="px-2" onClick={() => replayViewer.seek(replayViewer.tick() + SKIP_SECONDS * TICK_HZ)} aria-label="Forward 5 seconds" title="Forward 5 s (→)">
              +5 s
            </Button>
            {/* text written per frame by useTick (no React children, so React never fights it) */}
            <span ref={time} className="tabular w-[6.6rem] text-center text-[0.92rem] text-[#e6d3b8]" />
            <span className="flex items-center gap-0.5" role="group" aria-label="Playback speed">
              {REPLAY_SPEEDS.map((sp) => (
                <button key={sp} type="button" className="tab px-1.5 py-0.5 text-[0.82rem]" aria-pressed={v.speed === sp} aria-selected={v.speed === sp} onClick={() => replayViewer.setSpeed(sp)}>
                  {sp}×
                </button>
              ))}
            </span>
            <select
              className="field ml-auto w-44 py-1 text-[0.88rem]"
              value={v.follow}
              onChange={(e) => replayViewer.follow(Number(e.target.value))}
              aria-label="Camera"
              title="Follow a player (1-9) or move the camera freely (0, then WASD or drag)"
            >
              {v.slots.map((sl, i) => (
                <option key={sl.id} value={sl.id}>
                  {i < 9 ? `${i + 1} · ` : ''}Follow {sl.name}
                </option>
              ))}
              <option value={-1}>0 · Free camera</option>
            </select>
            <span className="hidden text-[0.8rem] whitespace-nowrap text-ash lg:inline">
              <Kbd>Tab</Kbd> scores
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
