import { useEffect, useRef } from 'react'
import { eventsSince, frame } from '../../game/frame'
import { useGame } from '../../game/store'
import type { Phase, SimEvent, SimState } from '../../sim/types'
import { TEAM_DRAW, TICK_HZ } from '../../sim'
import { useTick } from '../lib/ticker'
import { music, sfx } from '../lib/sound'
import { slotColor, slotName, TEAM_NAMES } from '../lib/view'
import { announce, Banner, Killfeed } from './Announce'
import { ItemGrid, SpellRow } from './SpellBar'
import { TopCenter, displayRound } from './TopBar'
import { ConnIndicator } from './ConnIndicator'
import { Gold, ProtectChip, Vitals } from './Vitals'
import { KeyCaps } from '../widgets'
import { Wordmark } from '../Brand'
import { resetSlotLayout } from '../lib/remap'
import { toggleFullscreen, useFullscreen } from '../lib/fullscreen'
import { inputViz } from '../../game/input'
import { displayName } from '../data/catalog'
import { bindLabel, slotKeyLabel, useBinds } from '../lib/keys'

interface HitMemory {
  /** spell / item of the last sourced hit */
  spell: string | null
  /** last damage came from lava (no source) */
  lava: boolean
}

/**
 * Turns phase changes and sim events into banners, sounds, music, auto shop
 * open/close and the killfeed. The session itself moves to the results
 * screen shortly after game over. Reads frame.ts from the shared rAF.
 */
function useDirector() {
  const st = useRef({
    phase: null as Phase | null,
    lastTick: -1,
    count: 0,
    gameOverSeen: false,
    /** per victim pawn id: what hit it last, for kill causes */
    hits: new Map<number, HitMemory>(),
  })

  useEffect(() => {
    // start the event cursor at "now" so a remount does not replay old kills
    st.current.lastTick = frame.curr?.tick ?? -1
  }, [])

  const onGameOver = (winners: number[], state: SimState) => {
    const s = st.current
    if (s.gameOverSeen) return
    s.gameOverSeen = true
    const local = frame.localPlayer
    const names = winners.map((id) => slotName(state, id))
    const won = winners.includes(local)
    announce.hold(winners.length === 0 ? 'Draw' : won ? 'Victory' : 'Defeat', names.length ? `${names.join(' and ')} ${names.length > 1 ? 'win' : 'wins'} the match` : '', won ? 'win' : 'danger')
    sfx(won ? 'ready' : 'back')
    music('none')
    useGame.getState().toggle('shopOpen', false)
  }

  /** One tick's events. Hits are read first: the sim emits 'damage' before 'projectileHit'. */
  const onBatch = (events: SimEvent[], state: SimState) => {
    const s = st.current
    const local = frame.localPlayer
    const projectileOn = new Map<number, string>()
    let scourge = false
    for (const e of events) {
      if (e.type === 'projectileHit' && e.target != null) projectileOn.set(e.target, e.spell)
      else if (e.type === 'explosion' && e.spell === 'scourge') scourge = true
    }
    for (const e of events) {
      switch (e.type) {
        case 'damage': {
          const prev = s.hits.get(e.target) ?? { spell: null, lava: false }
          if (e.source == null) s.hits.set(e.target, { spell: prev.spell, lava: true })
          else s.hits.set(e.target, { spell: projectileOn.get(e.target) ?? (scourge ? 'scourge' : null), lava: false })
          break
        }
        case 'death': {
          const hit = s.hits.get(e.pawn)
          s.hits.delete(e.pawn)
          const victim = { name: slotName(state, e.owner), color: slotColor(state, e.owner) }
          const killer = e.killer != null && e.killer !== e.owner ? { name: slotName(state, e.killer), color: slotColor(state, e.killer) } : null
          announce.kill({
            killer,
            victim,
            cause: hit?.spell ?? null,
            lava: hit ? hit.lava : true,
            local: e.owner === local || e.killer === local,
          })
          if (e.owner === local && state.phase === 'fight') {
            announce.banner('Knocked out', killer ? `${hit?.lava !== false ? 'Pushed into the lava' : 'Taken down'} by ${killer.name}` : 'The lava took you', 'danger', 2200)
          }
          break
        }
        case 'roundWin': {
          if (e.team === TEAM_DRAW || e.players.length === 0) {
            announce.banner('Draw', 'Nobody survived the round', 'normal', 2400)
            break
          }
          const mine = e.players.includes(local)
          const round = displayRound(state)
          const sub =
            e.players.length === 1 ? `${slotName(state, e.players[0])} takes round ${round}` : `${TEAM_NAMES[e.team] ?? 'Team ' + (e.team + 1)} team takes round ${round}`
          announce.banner(mine ? 'Round won' : 'Round lost', sub, mine ? 'win' : 'danger', 2600)
          sfx(mine ? 'ready' : 'back')
          break
        }
        case 'gameOver':
          onGameOver(e.winners, state)
          break
        default:
          break
      }
    }
  }

  const onPhase = (phase: Phase, state: SimState) => {
    const store = useGame.getState()
    switch (phase) {
      case 'warmup':
        announce.banner('Get ready', '', 'normal', 1600)
        music('shop')
        break
      case 'shop':
        // the shop opens itself between rounds; it never blocks movement
        st.current.hits.clear()
        store.toggle('shopOpen', true)
        music('shop')
        // SHOPTIME, as the original announced it; skipped when the phase is nearly over (late mount)
        if (state.phaseTicksLeft > 4 * TICK_HZ) announce.banner('Shop', `Round ${displayRound(state)} starts in ${Math.ceil(state.phaseTicksLeft / TICK_HZ)}s`, 'normal', 1700)
        break
      case 'fight':
        store.toggle('shopOpen', false)
        announce.banner('Fight!', '', 'fight', 1300)
        sfx('fight')
        music('fight')
        break
      case 'gameOver': {
        // normally announced by the gameOver event; this covers a missed one
        const top = Math.max(0, ...state.scores.map((x) => x.score))
        window.setTimeout(() => {
          if (!st.current.gameOverSeen && frame.curr) onGameOver(frame.curr.scores.filter((x) => x.score === top && top > 0).map((x) => x.id), frame.curr)
        }, 250)
        break
      }
    }
  }

  useTick(() => {
    const state = frame.curr
    if (!state) return
    const s = st.current
    // new match on the same mount (rematch): tick went backwards
    if (state.tick + TICK_HZ < s.lastTick) {
      s.lastTick = -1
      s.phase = null
      s.gameOverSeen = false
      s.hits.clear()
    }
    for (const batch of eventsSince(s.lastTick)) {
      onBatch(batch.events, state)
      s.lastTick = Math.max(s.lastTick, batch.tick)
    }

    if (state.phase !== s.phase) {
      s.phase = state.phase
      onPhase(state.phase, state)
    }

    if (state.phase === 'shop' || state.phase === 'warmup') {
      const secs = Math.ceil(state.phaseTicksLeft / TICK_HZ)
      if (secs >= 1 && secs <= 3 && secs !== s.count) {
        announce.banner(String(secs), '', 'count', 900)
        sfx('countdown')
      }
      s.count = secs
    } else {
      s.count = 0
    }
  })
}

/** Red edge pulse at low HP; "knocked out" strip while dead. */
function StatusLayer() {
  const vignette = useRef<HTMLDivElement>(null)
  const dead = useRef<HTMLDivElement>(null)
  const last = useRef({ low: false, dead: false })
  useTick(() => {
    const s = frame.curr
    const pawn = s?.pawns.find((p) => p.owner === frame.localPlayer)
    const fighting = s?.phase === 'fight'
    const low = !!pawn && pawn.alive && fighting && pawn.hp / Math.max(1, pawn.maxHp) < 0.25
    const isDead = !!pawn && !pawn.alive && fighting
    const l = last.current
    if (low !== l.low && vignette.current) vignette.current.dataset.on = String((l.low = low))
    if (isDead !== l.dead && dead.current) {
      dead.current.style.display = (l.dead = isDead) ? '' : 'none'
      const msg = dead.current.firstElementChild
      if (isDead && msg) msg.textContent = s?.settings.gameMode === 'deathmatch' ? 'Knocked out. You respawn in a few seconds.' : 'Knocked out. Watching the rest of the round.'
    }
  })
  return (
    <>
      <div ref={vignette} className="low-hp-vignette" data-on="false" />
      <div ref={dead} className="absolute right-0 left-0 text-center" style={{ display: 'none', bottom: 'calc(var(--hud-bottom-h) * var(--ui-scale, 1) + 10px)' }}>
        <span className="hud-backing hud-text-shadow text-lg font-semibold text-[#ffcfb8]">Knocked out. Watching the rest of the round.</span>
      </div>
    </>
  )
}

/** Aiming in "on release" or "normal" cast mode: what is armed and how to fire or cancel it. */
function AimHint() {
  const ref = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  const last = useRef('')
  useTick(() => {
    const a = inputViz.aim
    const name = a ? displayName(a.spell) || 'Spell' : ''
    const t = !a ? '' : a.mode === 'normal' ? `${name}: left click to cast, right click or Esc to cancel` : `${name}: release the key to cast`
    if (t === last.current || !ref.current || !text.current) return
    text.current.textContent = last.current = t
    ref.current.style.opacity = t ? '1' : '0'
  })
  return (
    <div
      ref={ref}
      className="absolute right-0 left-0 text-center transition-opacity duration-150"
      style={{ opacity: 0, bottom: 'calc(var(--hud-bottom-h) * var(--ui-scale, 1) + 40px)' }}
      aria-live="polite"
    >
      <span ref={text} className="hud-backing hud-text-shadow text-[1.1rem] font-semibold text-[#ffe2b0]" />
    </div>
  )
}

/** Shown until the first state arrives (session starting, or waiting for the host). */
function WaitingVeil() {
  const ref = useRef<HTMLDivElement>(null)
  const shown = useRef(true)
  useTick(() => {
    const has = !!frame.curr
    if (has === !shown.current) return
    shown.current = !has
    if (ref.current) ref.current.style.opacity = has ? '0' : '1'
  })
  return (
    <div ref={ref} className="absolute inset-0 grid place-items-center bg-obsidian/80 transition-opacity duration-500" style={{ pointerEvents: 'none' }}>
      <div className="flex flex-col items-center gap-4">
        <Wordmark size="md" />
        <span className="text-[1.05rem] font-semibold text-[#e6d3b8]">Entering the arena…</span>
      </div>
    </div>
  )
}

function Hints() {
  const binds = useBinds()
  const fullscreen = useFullscreen()
  // any spell / item key moved from the preset (HUD drag, shop drag, Settings)
  const slotCustom = useGame((s) => [...Object.keys(s.settings.keybinds ?? {}), ...Object.keys(s.settings.keybindsAlt ?? {})].some((k) => /^(spell|item)\d$/.test(k)))
  const hint = (key: string, label: string) => (
    <span className="flex items-center gap-1">
      <KeyCaps label={key} /> {label}
    </span>
  )
  return (
    <div className="hud-hints hud-backing hud-text-shadow flex items-center gap-3 py-1 text-[0.82rem] text-ash">
      {hint(bindLabel(binds, 'shop'), 'Shop')}
      {hint(bindLabel(binds, 'character'), 'Stats')}
      {hint(bindLabel(binds, 'scoreboard'), 'Scores')}
      {hint(slotKeyLabel(binds, 6), 'Fireball')}
      {hint(bindLabel(binds, 'stop'), 'Stop')}
      <button
        type="button"
        className="interactive flex items-center gap-1 rounded px-1.5 text-[0.82rem] text-ash hover:text-bone"
        onClick={() => void toggleFullscreen()}
        title="Fullscreen (Alt+Enter)"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
          <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      </button>
      {slotCustom && (
        <button type="button" className="interactive rounded px-1.5 text-[0.82rem] text-[#ffcf9a] underline-offset-2 hover:underline" onClick={() => resetSlotLayout()}>
          Reset key layout
        </button>
      )}
    </div>
  )
}

export function Hud() {
  useDirector()
  const hudLayout = useGame((s) => s.settings.hudLayout ?? 'center')
  return (
    <div className="hud select-none">
      <StatusLayer />

      <div className="absolute top-0 right-0 left-0 flex justify-center">
        <div className="hud-scale origin-top">
          <TopCenter />
        </div>
      </div>

      <div className="hud-scale absolute top-2 left-3 z-20">
        <ConnIndicator />
      </div>

      <div className="hud-scale absolute top-2 right-3">
        <Killfeed />
      </div>

      <Banner />
      <AimHint />

      {/* Dota-style bottom cluster flush to the screen edge, centered or in the bottom-right corner */}
      <div className={`absolute right-0 bottom-0 left-0 flex ${hudLayout === 'right' ? 'justify-end' : 'justify-center'}`}>
        <div className="hud-scale relative">
          <ProtectChip />
          <div className="hud-plate hud-bottom flex items-end gap-3 px-3 pt-2 pb-2" data-layout={hudLayout}>
            <div className="flex w-[342px] flex-col gap-1.5">
              <Vitals />
              <SpellRow />
            </div>
            <div className="flex flex-col items-end gap-1">
              <Gold />
              <ItemGrid />
            </div>
          </div>
        </div>
      </div>

      <div className="hud-scale absolute bottom-2 left-3 hidden xl:block">
        <Hints />
      </div>

      <WaitingVeil />
    </div>
  )
}
