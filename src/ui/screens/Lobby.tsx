import { FeedbackButton } from '../FeedbackButton'
import { EmblemBadge } from '../EmblemBadge'
import { useEffect, useRef, useState } from 'react'
import { BOT_DIFFICULTIES, useGame, type LobbyView } from '../../game/store'
import { MAX_PLAYERS, session } from '../../game/session'
import type { BotDifficulty, PlayerSlot, TeamMode } from '../../sim/types'
import { Button, Crown, GuestMark, Modal, PingBars, Switch } from '../widgets'
import { hostGame, hostOnServer, leaveToMenu, setReady, startMatch } from '../flow'
import { online } from '../../game/session'
import { pickRegion, regionProblem, regionStatus, useRegionChoice, useRegions } from '../lib/servers'
import { useNet } from '../lib/netmonitor'
import { usePolled, useTick } from '../lib/ticker'
import { headToHead, useEncounters } from '../lib/stats'
import { playerColor, playerGlyph, teamName } from '../lib/view'
import { PLAYER_COLORS } from '../../net/session'
import { sfx } from '../lib/sound'
import { MatchOptions } from './MatchOptions'
import { roomLink } from '../../net/code'
import { useLinks } from '../lib/netmonitor'
import { useMatchRenderReady } from '../MatchLayer'
import type { PeerNet } from '../lib/netstats'
import { BOT_ELO } from '../../bots'
import { PlayerColorPicker } from './PlayerColorPicker'
import { LobbyVote } from './LobbyVote'

const DIFFICULTY_LABEL: Record<BotDifficulty, string> = {
  dummy: 'Dummy',
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  brutal: 'Brutal',
  uber: 'Uber',
}

/** who each tier is for; the Elo is per round, measured bot vs bot (docs/PLAN.md §7) */
const DIFFICULTY_HINT: Record<BotDifficulty, string> = {
  dummy: 'a practice target that never acts',
  easy: 'new players',
  medium: 'knows the basics',
  hard: 'experienced players',
  brutal: 'veterans',
  uber: 'beats most humans',
}

function difficultyTip(d: BotDifficulty): string {
  return d === 'dummy' ? `${DIFFICULTY_LABEL[d]}, ${DIFFICULTY_HINT[d]}` : `${DIFFICULTY_LABEL[d]}, about ${BOT_ELO[d]} Elo: ${DIFFICULTY_HINT[d]}`
}

const ROLE_LABEL = { offline: 'Offline', host: 'Hosting', client: 'Joined' } as const

/** The host's own slot (session: the host's pings entry is 0 at id 0). */
const HOST_ID = 0

/** "Listed publicly" line of a room hosted from this PC: what the game server's listing does now. */
function pcListingText(l: ReturnType<typeof session.listing>, on: boolean): string {
  if (!on || !l || l.status === 'off') return 'Shows this game in Browse games; players join your PC directly'
  if (l.status === 'pending') return 'Listing in Browse games…'
  if (l.status === 'error') return `Not listed: ${l.error ?? 'the game server did not answer'}`
  return 'Listed in Browse · hosted on your PC'
}

function statusLine(l: LobbyView, humans: number): { text: string; tone: 'idle' | 'wait' | 'ok' | 'error' } {
  if (l.status === 'error' || l.error) return { text: l.error ?? 'Something went wrong with the connection.', tone: 'error' }
  if (l.notice) return { text: l.notice, tone: 'wait' }
  if (l.role === 'offline') return { text: 'Add bots, set the rules, start when ready.', tone: 'idle' }
  if (l.ranked && l.status === 'open') return { text: humans < 2 ? 'Waiting for another human · ranked rules are locked' : 'Ranked starts automatically · more players can join during the countdown', tone: humans < 2 ? 'wait' : 'ok' }
  if (l.role === 'host') {
    if (l.status === 'connecting' || l.status === 'idle') return { text: 'Opening a room…', tone: 'wait' }
    if (humans < 2) return { text: 'Waiting for a friend. Send them the room code.', tone: 'wait' }
    const waiting = l.slots.filter((x) => x.kind === 'human' && x.id !== l.localPlayer && !l.ready?.[x.id]).length
    if (waiting > 0) return { text: humans === 2 ? 'Your friend is here. Start whenever you like.' : `${humans - 1} friends are here, ${waiting} not ready yet.`, tone: 'ok' }
    return { text: humans === 2 ? 'Your friend is ready. Start the match.' : 'Everyone is ready. Start the match.', tone: 'ok' }
  }
  if (l.status === 'connecting' || l.status === 'idle') return { text: 'Connecting to the host…', tone: 'wait' }
  return { text: l.ready?.[l.localPlayer] ? 'You are ready. The host starts the match.' : 'Connected. Mark yourself ready when you are set.', tone: 'ok' }
}

function teamText(mode: TeamMode | undefined, team: number): string {
  if (mode === 'ffa') return 'Free for all'
  if (mode === 'shuffle') return 'Shuffled each round'
  return `${teamName(team)} team`
}

/**
 * Quick play countdown, written from the shared rAF (no React renders per
 * second): "Filling with bots in 8 s" with one player, "Starting in 4 s" with more.
 */
export function AutoStart({ at, fill, between = false }: { at: number; fill: boolean; between?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const last = useRef('')
  useTick((now) => {
    const secs = Math.max(0, Math.ceil((at - now) / 1000))
    const soon = secs > 0 && secs <= 10
    const t = soon ? `Match starts in ${secs} s` : between ? `Next match in ${secs} s` : fill ? `Filling with bots in ${secs} s` : `Starting in ${secs} s`
    if (t !== last.current && ref.current) {
      ref.current.textContent = last.current = t
      ref.current.dataset.startingSoon = String(soon)
    }
  })
  return <span ref={ref} className="tabular" title={between ? undefined : 'Bots fill empty seats until replaced by players'} data-testid="auto-start" />
}

/** a room hosted from your PC that has not opened after this long offers the game server instead */
const SLOW_HOST_MS = 8000

/**
 * Hosting from your PC that hangs (the broker unreachable, a strict network):
 * after a few seconds, offer the game server in one click, with its ping.
 * Never switches by itself; builds without a server never show it.
 */
function SlowHostHint() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), SLOW_HOST_MS)
    return () => window.clearTimeout(t)
  }, [])
  const statuses = useRegions(5000)
  const choice = useRegionChoice()
  if (!online.configured || !slow || session.transport() === 'server') return null
  const region = pickRegion(statuses, choice)
  if (!region || regionProblem(region)) return null
  return (
    <Button size="sm" onClick={() => hostOnServer(choice === 'auto' ? 'auto' : region.id)} data-testid="slow-host-server">
      Taking long? Host on game server ({region.label}
      {region.rttMs != null ? ` · ${region.rttMs} ms` : ''}) instead
    </Button>
  )
}

function PlayerCard({
  slot,
  isLocal,
  isHost,
  canEdit,
  teamMode,
  online,
  ping,
  net,
  unstable,
  ready,
  h2h,
  onColor,
}: {
  slot: PlayerSlot
  isLocal: boolean
  isHost: boolean
  canEdit: boolean
  teamMode: TeamMode | undefined
  online: boolean
  ping: number | undefined
  /** this player's link stats when known (host: every client; client: its own card) */
  net?: PeerNet
  /** host: this client's connection is bad right now */
  unstable?: boolean
  ready: boolean
  h2h: ReturnType<typeof headToHead>
  onColor?: () => void
}) {
  // lobby: team colours only in fixed teams (shuffle deals teams per round)
  const cb = useGame((s) => s.settings.colorblindPalette ?? false)
  const shown = teamMode === 'teams' ? 'teams' : 'ffa'
  const color = playerColor(slot, shown)
  const glyph = playerGlyph(slot, shown, cb)
  // the player's emblem badge when they wear one, else their colour gem
  const gem = slot.cosmetics?.emblem
    ? <EmblemBadge emblem={slot.cosmetics.emblem} color={color} size={28} />
    : <span className="lobby-player-gem" style={{ background: `linear-gradient(135deg, ${color}, ${color}77)` }} aria-hidden />
  return (
    <li
      className="lobby-player card-in relative flex items-center rounded-lg"
      style={{ background: `linear-gradient(90deg, ${color}1f, rgba(0,0,0,.22) 45%)`, boxShadow: `inset 3px 0 0 ${color}, inset 0 0 0 1px rgba(255,170,100,.08)` }}
    >
      {onColor ? <button type="button" className="lobby-player-color shrink-0 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold" onClick={onColor} aria-label="Change your color" title="Change your color">
        {gem}
        <span className="text-[0.65rem] leading-none text-gold">Color</span>
      </button> : <span className="lobby-player-color shrink-0" aria-hidden>{gem}</span>}
      <div className="min-w-0 flex-1">
        <div className="lobby-player-name flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-bold" title={slot.name}>
            {glyph && <span className="mr-1.5" style={{ color }} aria-hidden>{glyph}</span>}
            {slot.name}
          </span>
          {slot.guest && <GuestMark />}
          {isHost && <Crown />}
          {isLocal && <span className="chip text-gold">You</span>}
          {ready && <span className="chip pop-in bg-[rgba(127,227,154,0.14)] text-heal">Ready</span>}
          {unstable && slot.kind === 'human' && <span title="Unstable connection" className="chip pop-in bg-[rgba(255,110,60,0.14)] text-[#ffb08a]">Unstable</span>}
        </div>
        <div className="lobby-player-detail flex items-center gap-3 text-ash">
          <span>{slot.kind === 'bot' ? `Bot, ${DIFFICULTY_LABEL[slot.difficulty ?? 'medium'].toLowerCase()}` : 'Human'}</span>
          {teamMode !== 'teams' && <span className="hidden sm:inline">{teamText(teamMode, slot.team)}</span>}
          {!isLocal && h2h && (
            <span className={`font-semibold ${h2h.tone === 'up' ? 'text-heal' : h2h.tone === 'down' ? 'text-[#ff9b8a]' : 'text-bone/80'}`} title="Your record against this player">
              {h2h.text}
            </span>
          )}
          {!isLocal && !h2h && slot.kind === 'human' && <span className="text-ash/80">First meeting</span>}
        </div>
      </div>

      {online && slot.kind === 'human' && <PingBars ms={ping} host={isHost} net={net} />}

      {teamMode === 'teams' &&
        (canEdit ? (
          <select
            className="field lobby-player-select"
            aria-label={`Team for ${slot.name}`}
            value={slot.team}
            onChange={(e) => {
              sfx('click')
              session.setTeam(slot.id, Number(e.target.value))
            }}
          >
            {PLAYER_COLORS.map((_, i) => (
              <option key={i} value={i}>
                {teamName(i)}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-semibold text-bone/80">{teamText(teamMode, slot.team)}</span>
        ))}

      {slot.kind === 'bot' && canEdit && (
        <select
          className="field lobby-player-select"
          aria-label={`Difficulty for ${slot.name}`}
          title={difficultyTip(slot.difficulty ?? 'medium')}
          value={slot.difficulty ?? 'medium'}
          onChange={(e) => {
            sfx('click')
            session.setBotDifficulty(slot.id, e.target.value as BotDifficulty)
          }}
        >
          {BOT_DIFFICULTIES.map((d) => (
            <option key={d} value={d} title={difficultyTip(d)}>
              {DIFFICULTY_LABEL[d]}
            </option>
          ))}
        </select>
      )}

      {canEdit && !isLocal && (
        <Button size="sm" variant="ghost" sound="back" aria-label={`Remove ${slot.name}`} onClick={() => session.removeSlot(slot.id)}>
          {slot.kind === 'bot' ? 'Remove' : 'Kick'}
        </Button>
      )}
    </li>
  )
}

function useCopy(): [string | null, (key: string, text: string | null) => void] {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async (key: string, text: string | null) => {
    if (!text) return
    let ok = true
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      ok = false
    }
    sfx(ok ? 'ready' : 'error')
    setCopied(ok ? key : 'fail')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 2200)
  }
  return [copied, copy]
}

function InviteCard({ code, url, host }: { code: string | null; url: string | null; host: boolean }) {
  const [copied, copy] = useCopy()
  const link = url ?? (code ? roomLink(window.location.href, code) : null)
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="section-title">Room code</h3>
        <div className="flex gap-1" aria-label={code ? `Room code ${code.split('').join(' ')}` : 'Creating a room code'}>
          {(code ?? '·····').split('').map((ch, i) => (
            <span
              key={i}
              className="grid h-10 w-8 place-items-center rounded text-[1.5rem] font-bold text-[#fff1d6]"
              style={{ background: 'linear-gradient(180deg,#2c1d14,#160e0a)', boxShadow: 'inset 0 0 0 1px rgba(255,170,100,.3), 0 0 18px rgba(255,110,30,.15)' }}
              aria-hidden
            >
              {ch}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!code} sound={null} onClick={() => copy('code', code)}>
            {copied === 'code' ? 'Code copied' : 'Copy code'}
          </Button>
          <Button size="sm" disabled={!link} sound={null} onClick={() => copy('link', link)}>
            {copied === 'link' ? 'Link copied' : 'Copy link'}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-ash" aria-live="polite">
        {copied === 'fail'
          ? 'The browser blocked copying. Read the code out instead.'
          : host
            ? 'Your friend types this code under Join game, or opens the link.'
            : 'Others can join this room with the same code.'}
      </p>
    </div>
  )
}

export function Lobby() {
  const lobby = useGame((s) => s.lobby)
  const betweenMatches = useGame((s) => s.result !== null)
  const [botLevel, setBotLevel] = useState<BotDifficulty>('medium')
  const [colorOpen, setColorOpen] = useState(false)
  const encounters = useEncounters()
  const online = lobby.role !== 'offline'
  const localReady = !!lobby.ready?.[lobby.localPlayer]
  const localSlot = lobby.slots.find((slot) => slot.id === lobby.localPlayer && slot.kind === 'human')

  const links = useLinks()
  // how the room runs, once it is open (stable from then on)
  const transport = usePolled(() => (lobby.role !== 'offline' && lobby.status === 'open' ? session.transport() : null), String, 2)
  // server room: its region and your live ping to it (session.region(), polled with the transport)
  const room = usePolled(() => (transport === 'server' ? session.region() : null), (r) => (r ? `${r.label}:${r.rttMs}` : ''), 2)
  // a room hosted from this PC: its Browse games listing (on the game server)
  const listing = usePolled(() => (transport === 'p2p' ? session.listing() : null), (l) => (l ? `${l.status}:${l.region}:${l.error}` : ''), 2)
  // joined by code or from Browse games: the room's region is the one region when there is only one
  const regions = regionStatus()
  const serverName = room?.label ?? (regions.length === 1 ? regions[0].label : 'the game server')
  const liveMs = useNet((s) => {
    const ms = s.snap.peers.flatMap((p) => (p.rttMs == null ? [] : [Math.round(p.rttMs)]))
    return ms.length ? Math.max(...ms) : null
  }, String)
  const serverMs = room?.rttMs ?? liveMs ?? (regions.length === 1 ? regions[0].rttMs : null)
  // the hidden match scene warms up while the lobby is open (App's MatchLayer); Start waits for it, 6 s at most
  const warm = useMatchRenderReady(6000)
  const canEdit = lobby.role !== 'client' && !lobby.ranked
  const humans = lobby.slots.filter((s) => s.kind === 'human').length
  const waiting = lobby.waitingForPlayers ?? []
  const holding = lobby.quick && !lobby.ranked && waiting.length > 0
  const localWaiting = waiting.includes(lobby.localPlayer)
  const anyoneReady = lobby.slots.some((s) => s.kind === 'human' && lobby.ready?.[s.id])
  const automatic = (lobby.quick || lobby.ranked) && lobby.status === 'open' && !lobby.error && !lobby.maintenance
  const status = statusLine(lobby, humans)
  const full = lobby.slots.length >= MAX_PLAYERS
  const ready = !lobby.maintenance && lobby.slots.length >= 2 && lobby.status !== 'error' && (lobby.role !== 'host' || lobby.status === 'open')

  return (
    <div className="lobby-screen screen-in">
      <header className={`lobby-header flex flex-wrap items-end justify-between gap-3 ${lobby.ranked ? 'border-b border-[#bfc3d3]/30 pb-3' : ''}`}>
        <div className="flex flex-wrap items-end gap-4">
          <h1 className={`lobby-title display leading-none ${lobby.ranked ? 'text-[#e4ddf7]' : 'text-[#ffd890]'}`}>{lobby.ranked ? 'Ranked lobby' : 'Lobby'}</h1>
          <span className="chip mb-1.5">{lobby.ranked ? 'Global Elo' : lobby.quick ? 'Casual' : ROLE_LABEL[lobby.role]}</span>
          {transport && (
            <span
              className="chip mb-1.5 text-ash"
              title={
                transport === 'server'
                  ? `Game server in ${serverName}: everyone connects to it, so each player's ping depends on how far they are from ${serverName}`
                  : lobby.role === 'host'
                    ? "You're hosting; friends connect directly to you (lowest ping nearby, may fail on strict networks)"
                    : 'The host is running this room on their PC; you connect directly to them'
              }
              data-testid="lobby-transport"
            >
              {transport === 'server' ? `Server · ${serverName}${serverMs != null ? ` · ${serverMs} ms` : ''}` : lobby.role === 'host' ? 'Your PC' : "Host's PC"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {online && lobby.status === 'open' && <Button sound="back" onClick={() => useGame.getState().setScreen('menu')} title="Browse menus and stats while staying in this lobby" data-testid="lobby-browse-menu">
            Menu
          </Button>}
          <Button variant="danger" sound="back" onClick={leaveToMenu}>
            Leave lobby
          </Button>
          <FeedbackButton compact />
        </div>
      </header>

      <div className="lobby-notices">
      {lobby.maintenance && <section role="status" data-testid="lobby-maintenance" className="rounded-lg border border-gold/40 bg-[#281d13] px-5 py-4 text-center">
        <h2 className="text-xl font-semibold text-gold">Region updating</h2>
        <p className="mt-1 text-sm text-bone">{lobby.maintenance}</p>
        <Button className="mt-3" onClick={leaveToMenu}>Choose another region</Button>
      </section>}
      {automatic && <section
        className={`lobby-auto-status shrink-0 rounded-lg border text-center ${lobby.ranked ? 'border-[#bfc3d3]/40 bg-[linear-gradient(110deg,rgba(68,48,74,.75),rgba(23,18,29,.94),rgba(77,35,44,.65))] shadow-[inset_0_1px_0_rgba(221,212,244,.12),0_0_24px_rgba(158,89,96,.08)]' : 'border-[#e7a656]/35 bg-[linear-gradient(110deg,rgba(68,40,15,.65),rgba(28,18,13,.94),rgba(68,40,15,.65))] shadow-[inset_0_1px_0_rgba(255,216,144,.12),0_0_24px_rgba(255,150,50,.06)]'}`}
        aria-label="Automatic match start"
        role="status"
        aria-live="polite"
        data-testid="lobby-auto-start"
      >
        <p className="text-[0.74rem] font-bold tracking-[0.18em] text-gold/80 uppercase">{lobby.ranked ? 'Ranked matchmaking' : betweenMatches ? 'Casual · Next match' : 'Casual matchmaking'}</p>
        <p className="lobby-auto-title mt-0.5 leading-tight font-semibold text-[#ffe0a6]">
          {holding ? 'Waiting for more players' : lobby.ranked && humans < 2 ? 'Waiting for one more player' : lobby.autoStart ? <AutoStart at={lobby.autoStart.at} fill={lobby.autoStart.fill} between={betweenMatches} /> : 'Waiting for players to join…'}
        </p>
        <p className="mt-1 text-[0.95rem] text-[#e3c9a5]">
          {holding
            ? humans === 1 ? 'Lobby stays public. Press Play now whenever you are ready.' : 'Lobby stays public. Anyone can press Ready to start the countdown.'
            : lobby.ranked && humans < 2
            ? `${humans} / 2 human players · The 60-second countdown begins when another player joins.`
            : lobby.autoStart?.fill
              ? 'Players can join while the lobby fills. Bots take the empty seats.'
              : 'Starts automatically. More players can join before the countdown ends.'}
        </p>
        {!lobby.ranked && <div className="mt-2 flex justify-center">
          <Button size="sm" disabled={anyoneReady} onClick={() => session.setWaitingForPlayers(!localWaiting)} aria-pressed={localWaiting} data-testid="casual-lobby-wait" title={anyoneReady ? 'A player is ready; the countdown continues' : 'Keep this lobby open until you resume or any player readies'}>
            {localWaiting ? waiting.length === 1 ? 'Resume countdown' : 'Stop waiting' : 'Wait for players'}
          </Button>
        </div>}
      </section>}
      {lobby.ranked && <p className="rounded border border-[#bfc3d3]/20 bg-black/25 px-4 py-2 text-sm text-[#e3d9ba]" data-testid="ranked-rules">
        8 players · 5 rounds · tied leaders fight a final brawl · Brutal bots fill empty seats.
      </p>}
      <LobbyVote />
      </div>

      <div className="lobby-panels">
        <section className="panel lobby-roster" aria-label="Players">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="section-title lobby-roster-title">Warlocks</h2>
            <span className="tabular text-ash">
              {lobby.slots.length} / {lobby.ranked ? 8 : MAX_PLAYERS}
            </span>
          </div>
          <ul className="lobby-roster-list flex min-h-0 flex-1 flex-col overflow-y-auto pr-1" aria-label="Warlock roster">
            {lobby.slots.map((s) => (
              <PlayerCard
                key={s.id}
                slot={s}
                isLocal={s.id === lobby.localPlayer}
                isHost={online && !lobby.quick && s.id === HOST_ID}
                canEdit={canEdit}
                teamMode={lobby.settings?.teamMode}
                online={online}
                ping={lobby.pings?.[s.id]}
                net={links.links[s.id]}
                unstable={links.flagged.includes(s.id)}
                ready={!!lobby.ready?.[s.id]}
                h2h={headToHead(encounters, s)}
                onColor={s.id === localSlot?.id ? () => setColorOpen(true) : undefined}
              />
            ))}
            {lobby.slots.length === 0 && <li className="py-6 text-ash">{lobby.status === 'error' ? 'No players.' : 'Setting up the lobby…'}</li>}
          </ul>
          {canEdit && (
            <div className="lobby-bot-controls flex flex-wrap items-center gap-2 border-t border-[rgba(255,170,100,0.1)]">
              <select
                className="field w-32"
                aria-label="New bot difficulty"
                title={difficultyTip(botLevel)}
                value={botLevel}
                onChange={(e) => setBotLevel(e.target.value as BotDifficulty)}
              >
                {BOT_DIFFICULTIES.map((d) => (
                  <option key={d} value={d} title={difficultyTip(d)}>
                    {DIFFICULTY_LABEL[d]}
                  </option>
                ))}
              </select>
              <Button disabled={full || lobby.status === 'error'} onClick={() => session.addBot(botLevel)}>
                Add bot
              </Button>
              {full && <span className="text-sm text-ash">The arena holds ten.</span>}
            </div>
          )}
        </section>

        <section className="panel lobby-options" aria-label="Match options">
          <div className="-ml-2 min-h-0 flex-1 overflow-y-auto pl-2 pr-2">
            {(lobby.role === 'host' || (lobby.role === 'client' && lobby.roomCode)) && <InviteCard code={lobby.roomCode} url={lobby.joinUrl} host={lobby.role === 'host'} />}
            {((transport === 'server' && (lobby.quick || lobby.role === 'host')) || (transport === 'p2p' && lobby.role === 'host' && regions.length > 0)) && (
              <div className="mb-3 flex items-center justify-between gap-4 rounded-lg bg-[rgba(0,0,0,0.25)] px-3 py-2">
                <span className="flex flex-col">
                  <span className="font-semibold">Listed publicly</span>
                  <span className="text-[0.88rem] text-ash">
                    {lobby.ranked ? 'Ranked lobbies are open while matchmaking; rules are locked' : lobby.quick ? 'Casual games are always listed in Browse games' : transport === 'p2p' ? pcListingText(listing, !!lobby.public) : 'Anyone can find and join from Browse games'}
                  </span>
                </span>
                <Switch label="Listed publicly" checked={lobby.quick || lobby.ranked ? true : !!lobby.public} disabled={!!lobby.quick || !!lobby.ranked} onChange={(v) => session.setPublic(v)} />
              </div>
            )}
            <MatchOptions settings={lobby.settings} editable={canEdit} voting={canEdit && lobby.role === 'host' && !lobby.quick && humans >= 2 && lobby.status === 'open'} activeVote={lobby.vote ?? null} />
          </div>
        </section>
      </div>

      <footer className="lobby-footer flex shrink-0 flex-wrap items-center justify-between gap-4">
        {(!automatic || lobby.notice) && <p
          className={`flex items-center gap-2.5 text-[1.08rem] font-semibold ${status.tone === 'error' ? 'text-[#ff9b8a]' : status.tone === 'ok' ? 'text-heal' : 'text-[#f0d9b8]'}`}
          role="status"
          aria-live="polite"
        >
          {status.tone === 'wait' && <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-ember" aria-hidden />}
          {status.text}
        </p>}
        {lobby.role === 'host' && lobby.status === 'connecting' && <SlowHostHint />}
        <div className="ml-auto flex gap-3">
          {lobby.status === 'error' && lobby.role === 'host' && <Button onClick={() => hostGame()}>Try again</Button>}
          {canEdit ? (
            <Button
              variant="primary"
              size="lg"
              disabled={!ready || !warm.ready || !!lobby.vote}
              sound="ready"
              onClick={startMatch}
              title={lobby.vote ? 'Wait for the lobby vote to finish' : !ready ? 'Add a bot or wait for a friend' : !warm.ready ? 'Loading the arena so the match starts without a hitch' : undefined}
              data-testid="start-match"
              data-ready={ready && warm.ready && !lobby.vote}
            >
              {ready && !warm.ready ? (
                <>
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-ember" aria-hidden />
                  Preparing arena…
                </>
              ) : (
                'Start match'
              )}
            </Button>
          ) : (
            lobby.status === 'open' && (lobby.ranked || lobby.quick ? (
              <Button variant={localReady ? 'default' : 'primary'} size="lg" disabled={!!lobby.maintenance} sound={localReady ? 'back' : 'click'} onClick={() => setReady(!localReady)} title={holding ? 'Release the wait. When everyone is ready, the match starts in 10 seconds.' : 'When every player is ready, the match starts in 10 seconds'} data-testid={lobby.ranked ? 'ranked-lobby-ready' : 'casual-lobby-ready'}>
                {localReady ? 'Not ready' : !lobby.ranked && humans === 1 ? 'Play now' : 'Ready to start'}
              </Button>
            ) : (
              <Button variant={localReady ? 'default' : 'primary'} size="lg" sound={localReady ? 'back' : 'ready'} onClick={() => setReady(!localReady)}>
                {localReady ? 'Not ready' : 'Ready'}
              </Button>
            ))
          )}
        </div>
      </footer>
      {colorOpen && localSlot && <Modal title="Your color" width="max-w-md" onClose={() => setColorOpen(false)}><PlayerColorPicker local={localSlot} slots={lobby.slots} editable={lobby.status === 'open'} /></Modal>}
    </div>
  )
}
