import { useEffect, useRef, useState } from 'react'
import { BOT_DIFFICULTIES, useGame, type LobbyView } from '../../game/store'
import { MAX_PLAYERS, session } from '../../game/session'
import type { BotDifficulty, PlayerSlot, TeamMode } from '../../sim/types'
import { Button, Crown, PingBars } from '../widgets'
import { hostGame, hostOnServer, leaveToMenu, setReady, startMatch } from '../flow'
import { online } from '../../game/session'
import { pickRegion, regionProblem, useRegionChoice, useRegions } from '../lib/servers'
import { useNet } from '../lib/netmonitor'
import { usePolled } from '../lib/ticker'
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

function statusLine(l: LobbyView, humans: number): { text: string; tone: 'idle' | 'wait' | 'ok' | 'error' } {
  if (l.status === 'error' || l.error) return { text: l.error ?? 'Something went wrong with the connection.', tone: 'error' }
  if (l.notice) return { text: l.notice, tone: 'wait' }
  if (l.role === 'offline') return { text: 'Add bots, set the rules, start when ready.', tone: 'idle' }
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
}) {
  // lobby: team colours only in fixed teams (shuffle deals teams per round)
  const cb = useGame((s) => s.settings.colorblindPalette ?? false)
  const shown = teamMode === 'teams' ? 'teams' : 'ffa'
  const color = playerColor(slot, shown)
  const glyph = playerGlyph(slot, shown, cb)
  return (
    <li
      className="card-in relative flex items-center gap-3.5 rounded-lg px-3 py-2.5"
      style={{ background: `linear-gradient(90deg, ${color}1f, rgba(0,0,0,.22) 45%)`, boxShadow: `inset 3px 0 0 ${color}, inset 0 0 0 1px rgba(255,170,100,.08)` }}
    >
      <span
        className="h-10 w-10 shrink-0 rotate-45 rounded-[5px]"
        style={{ background: `linear-gradient(135deg, ${color}, ${color}77)`, boxShadow: `0 0 16px ${color}66, inset 0 0 0 1px rgba(255,255,255,.3)` }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[1.15rem] font-bold">
            {glyph && <span className="mr-1.5" style={{ color }} aria-hidden>{glyph}</span>}
            {slot.name}
          </span>
          {isHost && <Crown />}
          {isLocal && <span className="chip text-gold">You</span>}
          {ready && <span className="chip pop-in bg-[rgba(127,227,154,0.14)] text-heal">Ready</span>}
          {unstable && slot.kind === 'human' && <span className="chip pop-in bg-[rgba(255,110,60,0.14)] text-[#ffb08a]">Unstable connection</span>}
        </div>
        <div className="flex items-center gap-3 text-sm text-ash">
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
            className="field w-28"
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
          className="field w-28"
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
    <div className="mb-6">
      <h3 className="section-title mb-2">Room code</h3>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex gap-1.5" aria-label={code ? `Room code ${code.split('').join(' ')}` : 'Creating a room code'}>
          {(code ?? '·····').split('').map((ch, i) => (
            <span
              key={i}
              className="grid h-14 w-12 place-items-center rounded-md text-[2.1rem] font-bold text-[#fff1d6]"
              style={{ background: 'linear-gradient(180deg,#2c1d14,#160e0a)', boxShadow: 'inset 0 0 0 1px rgba(255,170,100,.3), 0 0 18px rgba(255,110,30,.15)' }}
              aria-hidden
            >
              {ch}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <Button size="sm" disabled={!code} sound={null} onClick={() => copy('code', code)}>
            {copied === 'code' ? 'Code copied' : 'Copy code'}
          </Button>
          <Button size="sm" disabled={!link} sound={null} onClick={() => copy('link', link)}>
            {copied === 'link' ? 'Link copied' : 'Copy link'}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-sm text-ash" aria-live="polite">
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
  const [botLevel, setBotLevel] = useState<BotDifficulty>('medium')
  const encounters = useEncounters()
  const online = lobby.role !== 'offline'
  const localReady = !!lobby.ready?.[lobby.localPlayer]

  const links = useLinks()
  // how the room runs, once it is open (stable from then on)
  const transport = usePolled(() => (lobby.role !== 'offline' && lobby.status === 'open' ? session.transport() : null), String, 2)
  // server room: its region and your live ping to it (session.region(), polled with the transport)
  const room = usePolled(() => (transport === 'server' ? session.region() : null), (r) => (r ? `${r.label}:${r.rttMs}` : ''), 2)
  const serverName = room?.label ?? 'the game server'
  const liveMs = useNet((s) => {
    const ms = s.snap.peers.flatMap((p) => (p.rttMs == null ? [] : [Math.round(p.rttMs)]))
    return ms.length ? Math.max(...ms) : null
  }, String)
  const serverMs = room?.rttMs ?? liveMs
  // the hidden match scene warms up while the lobby is open (App's MatchLayer); Start waits for it, 6 s at most
  const warm = useMatchRenderReady(6000)
  const canEdit = lobby.role !== 'client'
  const humans = lobby.slots.filter((s) => s.kind === 'human').length
  const status = statusLine(lobby, humans)
  const full = lobby.slots.length >= MAX_PLAYERS
  const ready = lobby.slots.length >= 2 && lobby.status !== 'error' && (lobby.role !== 'host' || lobby.status === 'open')

  return (
    <div className="screen-in flex h-full flex-col px-[max(16px,4vw)] py-[max(16px,3vh)]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-4">
          <h1 className="display text-6xl leading-none text-[#ffd890]">Lobby</h1>
          <span className="chip mb-1.5">{ROLE_LABEL[lobby.role]}</span>
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
        <div className="flex gap-2">
          <Button variant="danger" sound="back" onClick={leaveToMenu}>
            Leave lobby
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <section className="panel flex min-h-0 flex-col p-6" aria-label="Players">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="section-title text-[1.9rem]">Warlocks</h2>
            <span className="tabular text-ash">
              {lobby.slots.length} / {MAX_PLAYERS}
            </span>
          </div>
          <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
            {lobby.slots.map((s) => (
              <PlayerCard
                key={s.id}
                slot={s}
                isLocal={s.id === lobby.localPlayer}
                isHost={online && s.id === HOST_ID}
                canEdit={canEdit}
                teamMode={lobby.settings?.teamMode}
                online={online}
                ping={lobby.pings?.[s.id]}
                net={links.links[s.id]}
                unstable={links.flagged.includes(s.id)}
                ready={!!lobby.ready?.[s.id]}
                h2h={headToHead(encounters, s)}
              />
            ))}
            {lobby.slots.length === 0 && <li className="py-6 text-ash">{lobby.status === 'error' ? 'No players.' : 'Setting up the lobby…'}</li>}
          </ul>
          {canEdit && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[rgba(255,170,100,0.1)] pt-4">
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

        <section className="panel flex min-h-0 flex-col p-6" aria-label="Match options">
          <div className="min-h-0 flex-1 overflow-y-auto pr-2">
            {(lobby.role === 'host' || (lobby.role === 'client' && lobby.roomCode)) && <InviteCard code={lobby.roomCode} url={lobby.joinUrl} host={lobby.role === 'host'} />}
            <MatchOptions settings={lobby.settings} editable={canEdit} />
          </div>
        </section>
      </div>

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <p
          className={`flex items-center gap-2.5 text-[1.08rem] font-semibold ${status.tone === 'error' ? 'text-[#ff9b8a]' : status.tone === 'ok' ? 'text-heal' : 'text-[#f0d9b8]'}`}
          role="status"
          aria-live="polite"
        >
          {status.tone === 'wait' && <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-ember" aria-hidden />}
          {status.text}
        </p>
        {lobby.role === 'host' && lobby.status === 'connecting' && <SlowHostHint />}
        <div className="flex gap-3">
          {lobby.status === 'error' && lobby.role === 'host' && <Button onClick={hostGame}>Try again</Button>}
          {canEdit ? (
            <Button
              variant="primary"
              size="lg"
              disabled={!ready || !warm.ready}
              sound="ready"
              onClick={startMatch}
              title={!ready ? 'Add a bot or wait for a friend' : !warm.ready ? 'Loading the arena so the match starts without a hitch' : undefined}
              data-testid="start-match"
              data-ready={ready && warm.ready}
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
            lobby.status === 'open' && (
              <Button variant={localReady ? 'default' : 'primary'} size="lg" sound={localReady ? 'back' : 'ready'} onClick={() => setReady(!localReady)}>
                {localReady ? 'Not ready' : 'Ready'}
              </Button>
            )
          )}
        </div>
      </footer>
    </div>
  )
}
