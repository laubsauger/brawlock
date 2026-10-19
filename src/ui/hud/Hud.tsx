import { useEffect, useRef } from 'react'
import { eventsSince, frame } from '../../game/frame'
import { useGame } from '../../game/store'
import type { Phase, SimEvent, SimState } from '../../sim/types'
import { TEAM_DRAW, TICK_HZ, gameWinners } from '../../sim'
import { usePolled, useTick } from '../lib/ticker'
import { music, sfx } from '../lib/sound'
import { slotColor, slotGlyph, slotName, teamName, winnersText } from '../lib/view'
import { announce, Banner, KillCallout, Killfeed } from './Announce'
import { InnateRow, ItemRow, SpellRow } from './SpellBar'
import { ShrinkWarning, TopCenter, FinalBrawlStatus, displayRound, roundLabel } from './TopBar'
import { ConnIndicator } from './ConnIndicator'
import { InspectCard, SpectateChip } from './Inspect'
import { Gold, ProtectChip } from './Vitals'
import { Button, KeyCaps } from '../widgets'
import { Wordmark } from '../Brand'
import { matchRenderReady } from '../renderBridge'
import { resetSlotLayout } from '../lib/remap'
import { toggleFullscreen, useFullscreen } from '../lib/fullscreen'
import { inputViz } from '../../game/input'
import { displayName } from '../data/catalog'
import { bindLabel, slotKeyLabel, useBinds } from '../lib/keys'
import { ANNOUNCER_TEXT, roundCall } from '../../game/announcer'
import { DeathFeedback } from './DeathFeedback'

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
    const who = winnersText(state.slots, winners, state.settings.teamMode)
    const won = winners.includes(local)
    // the announcer's words; a spectator gets no Victory / Defeat (and hears none)
    const title = winners.length === 0 ? ANNOUNCER_TEXT.draw : local < 0 ? 'Match over' : won ? ANNOUNCER_TEXT.victory : ANNOUNCER_TEXT.defeat
    announce.hold(title, who ? `${who.text} ${who.plural ? 'win' : 'wins'} the match` : '', won ? 'win' : local < 0 ? 'normal' : 'danger')
    sfx(won ? 'ready' : 'back')
    music('none')
    useGame.getState().toggle('shopOpen', false)
  }

  /** One authoritative tick's events. */
  const onBatch = (events: SimEvent[], state: SimState) => {
    const local = frame.localPlayer
    for (const e of events) {
      switch (e.type) {
        case 'death': {
          if (e.cause === 'disconnect') break
          const victim = { name: slotName(state, e.owner), color: slotColor(state, e.owner), glyph: slotGlyph(state, e.owner) }
          const killer = e.killer != null && e.killer !== e.owner ? { name: slotName(state, e.killer), color: slotColor(state, e.killer), glyph: slotGlyph(state, e.killer) } : null
          announce.kill({
            killer,
            victim,
            cause: e.cause ?? null,
            lava: e.cause === 'lava',
            local: e.owner === local || e.killer === local,
            myKill: !!killer && e.killer === local,
          })
          // your kill, wherever it happened (an off-screen push into the lava too)
          if (killer && e.killer === local) announce.myKill(victim)
          break
        }
        case 'roundWin': {
          if (e.team === TEAM_DRAW || e.players.length === 0) {
            announce.banner(ANNOUNCER_TEXT.draw, 'Nobody survived the round', 'normal', 2400)
            break
          }
          const mine = e.players.includes(local)
          const round = displayRound(state)
          const sub =
            e.players.length === 1 ? `${slotName(state, e.players[0])} takes round ${round}` : `${teamName(e.team)} team takes round ${round}`
          announce.banner(mine ? ANNOUNCER_TEXT.round_won : 'Round lost', sub, mine ? 'win' : 'danger', 2600)
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
        store.toggle('shopOpen', true)
        music('shop')
        // SHOPTIME, as the original announced it; skipped when the phase is nearly over (late mount)
        if (state.phaseTicksLeft > 4 * TICK_HZ) announce.banner('Shop', `${roundLabel(state)} starts in ${Math.ceil(state.phaseTicksLeft / TICK_HZ)}s`, 'normal', 1700)
        break
      case 'fight':
        store.toggle('shopOpen', false)
        announce.banner(ANNOUNCER_TEXT.fight, '', 'fight', 1300)
        sfx('fight')
        music('fight')
        break
      case 'gameOver': {
        // normally announced by the gameOver event; this covers a missed one
        window.setTimeout(() => {
          const current = frame.curr
          if (st.current.gameOverSeen || !current || current.phase !== 'gameOver') return
          const winners = gameWinners(current)
          if (winners !== null) onGameOver(winners, current)
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
        // the announcer's call for this round, word for word ("Round Two!", "Match Point!")
        const call = roundCall(state)
        announce.banner(String(secs), call ? ANNOUNCER_TEXT[call] : '', 'count', 900)
        sfx('countdown')
      }
      s.count = secs
    } else {
      s.count = 0
    }
  })
}

/** Red edge pulse at low HP. Confirmed knockouts have their own feedback. */
function StatusLayer() {
  const vignette = useRef<HTMLDivElement>(null)
  const last = useRef(false)
  useTick(() => {
    const s = frame.curr
    const pawn = s?.pawns.find((p) => p.owner === frame.localPlayer)
    const fighting = s?.phase === 'fight'
    const low = !!pawn && pawn.alive && fighting && pawn.hp / Math.max(1, pawn.maxHp) < 0.25
    if (low !== last.current && vignette.current) vignette.current.dataset.on = String((last.current = low))
  })
  return (
    <div ref={vignette} className="low-hp-vignette" data-on="false" />
  )
}

/** The session owns the transient notice's lifetime and broadcasts it to the room. */
function SessionNotice() {
  const notice = useGame((s) => s.lobby.notice)
  const waiting = useGame((s) => s.lobby.waitingForRound)
  const maintenance = useGame((s) => s.lobby.maintenance)
  return notice || waiting || maintenance ? (
    <div className="hud-scale absolute top-11 left-3 flex max-w-[min(28rem,calc(100%_-_1.5rem))] flex-col items-start gap-1.5 text-sm font-semibold text-[#e6d3b8] max-sm:top-24">
      {waiting && <div className="rounded border border-gold/30 bg-obsidian/90 px-3 py-2" role="status" aria-live="polite">
        <div className="text-gold">Joining next round</div>
        <div className="mt-0.5 text-xs font-normal text-ash">Watching until this round ends</div>
      </div>}
      {notice && <div className="rounded border border-white/10 bg-obsidian/85 px-3 py-1.5" role="status" aria-live="polite" aria-atomic="true">{notice}</div>}
      {maintenance && <div className="rounded border border-gold/30 bg-obsidian/90 px-3 py-2 text-xs font-normal text-[#e6d3b8]" role="status">{maintenance}</div>}
    </div>
  ) : null
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

/** Longest the veil waits for the scene to finish warming once the first state is in. */
const VEIL_RENDER_WAIT_MS = 6000

/**
 * Shown until the first state arrives (session starting, or waiting for the
 * host) and the match scene is warm (a client that joined late may still be
 * compiling). Sits above the docks: the shop opens under it, not over it.
 */
export function WaitingVeil() {
  const ref = useRef<HTMLDivElement>(null)
  const shown = useRef(true)
  const t0 = useRef(performance.now())
  useTick((now) => {
    const has = !!frame.curr && (matchRenderReady() || now - t0.current > VEIL_RENDER_WAIT_MS)
    if (has === !shown.current) return
    shown.current = !has
    if (ref.current) ref.current.style.opacity = has ? '0' : '1'
  })
  return (
    <div ref={ref} className="absolute inset-0 z-[45] grid place-items-center bg-obsidian/80 transition-opacity duration-500" style={{ pointerEvents: 'none' }}>
      <div className="flex flex-col items-center gap-4">
        <Wordmark size="md" />
        <span className="text-[1.05rem] font-semibold text-[#e6d3b8]">Entering the arena…</span>
      </div>
    </div>
  )
}

/**
 * Key legend, bottom left: secondary info, so it stays small and quiet and
 * never competes with the spell bar. Fades further after the first round
 * (the keys are learned by then). Settings > Interface can hide it.
 */
function Hints() {
  const binds = useBinds()
  // any spell / item key moved from the preset (HUD drag, shop drag, Settings)
  const slotCustom = useGame((s) => [...Object.keys(s.settings.keybinds ?? {}), ...Object.keys(s.settings.keybindsAlt ?? {})].some((k) => /^(spell|item)\d$/.test(k)))
  const faded = usePolled(() => (frame.curr ? displayRound(frame.curr) > 1 : false), String, 2)
  const hint = (key: string, label: string) => (
    <span className="flex items-center gap-1">
      <KeyCaps label={key} /> {label}
    </span>
  )
  return (
    <div className="hud-hints hud-backing flex items-center gap-2 px-1.5 py-0.5 text-[0.7rem] leading-none whitespace-nowrap text-ash/80" data-faded={faded}>
      {hint(bindLabel(binds, 'shop'), 'Shop')}
      {hint(bindLabel(binds, 'character'), 'Stats')}
      {hint(bindLabel(binds, 'scoreboard'), 'Scores')}
      {hint(slotKeyLabel(binds, 6), 'Fireball')}
      {hint(bindLabel(binds, 'stop'), 'Stop')}
      {slotCustom && (
        <button type="button" className="interactive rounded px-1 text-[0.7rem] text-[#ffcf9a]/85 underline-offset-2 hover:underline" onClick={() => resetSlotLayout()}>
          Reset key layout
        </button>
      )}
    </div>
  )
}

/** Small icon-only fullscreen toggle, top-right corner: tertiary, quiet until hovered. */
function FullscreenButton() {
  const fullscreen = useFullscreen()
  const label = fullscreen ? 'Exit fullscreen (Alt+Enter)' : 'Fullscreen (Alt+Enter)'
  return (
    <Button
      variant="ghost"
      size="sm"
      sound={null}
      className="hud-fs interactive px-1.5"
      onClick={() => void toggleFullscreen()}
      title={label}
      aria-label={label}
      data-testid="hud-fullscreen"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        {fullscreen ? (
          <path d="M6 2v4H2M10 2v4h4M14 10h-4v4M2 10h4v4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        ) : (
          <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        )}
      </svg>
    </Button>
  )
}

export function Hud() {
  useDirector()
  const hudLayout = useGame((s) => s.settings.hudLayout ?? 'center')
  const showHints = useGame((s) => s.settings.showHints ?? true)
  return (
    <div className="hud select-none">
      <StatusLayer />
      <DeathFeedback />
      <SessionNotice />

      <div className="absolute top-0 right-0 left-0 flex justify-center">
        <div className="hud-scale flex origin-top flex-col items-center">
          <TopCenter />
          <FinalBrawlStatus />
          {/* at most one row under the clock: the shrink warning and your KO callout share it */}
          <div className="mt-0.5 flex items-center justify-center gap-2">
            <SpectateChip />
            <ShrinkWarning />
            <KillCallout />
          </div>
        </div>
      </div>

      <div className="hud-scale absolute top-2 left-3 z-20">
        <ConnIndicator />
      </div>

      {/* top-right corner: fullscreen toggle, kill feed under it */}
      <div className="hud-scale absolute top-2 right-3 flex flex-col items-end gap-1.5">
        <FullscreenButton />
        <Killfeed />
      </div>

      <Banner />
      <AimHint />
      <InspectCard />

      {/* One row of abilities and items, centered or in the bottom-right corner. */}
      <div className={`absolute right-0 bottom-0 left-0 flex ${hudLayout === 'right' ? 'justify-end' : 'justify-center'}`}>
        <div className="hud-scale relative">
          <ProtectChip />
          <div className="hud-plate hud-bottom" data-layout={hudLayout}>
            <InnateRow />
            <SpellRow />
            <ItemRow />
            <div className="hotbar-gold">
              <Gold />
            </div>
          </div>
        </div>
      </div>

      {showHints && (
        <div className="hud-scale absolute bottom-2 left-3 hidden xl:block">
          <Hints />
        </div>
      )}

    </div>
  )
}
