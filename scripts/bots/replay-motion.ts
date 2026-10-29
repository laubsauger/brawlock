/**
 * How humans and bots move in recorded matches, on the shared motion meter (src/bots/motion.ts;
 * docs/moonshot/specs/bot-motion.md, "The plausibility metric, permanently").
 *   npm run bots:replay-motion -- [folder | file.brawlock ...] [--reference BeFlat] [--out file.json]
 *
 * Reads every .brawlock file in the folders given (media/replays by default) and the files given,
 * re-simulates each one and meters every player. Humans are grouped by name, bots by tier. Each
 * group gets its pooled measures and the min and max of its per-match values (for a tier, every
 * bot of that tier in every match counts as one value). `--reference` names the top-rated human,
 * whose numbers the gates are read from.
 *
 * Build lock: a replay re-simulates only on the build that recorded it, the one with its netcode
 * id (`netId`). To find that build, the script computes the netcode id of release tags (newest
 * first), then of the commits on main (newest first, at most MAX_COMMITS), each with the commit's
 * own scripts/net-id.mjs over a `git archive` of what it hashes. Ids are cached per commit in the
 * OS temp folder, so a rerun only computes new commits. The build's src is extracted with
 * `git archive` into a temporary folder that is removed at exit; the working tree is never
 * touched. The meter is this checkout's, so its tick rate is set to the replay's as well.
 *
 * Without the build, a replay still gives orders/s, casts/s and move-order gaps from its recorded
 * inputs, which need no positions. Fight time then comes from its round and death markers, and
 * the other measures are null in the JSON. A desync is printed and recorded per replay; its
 * measures are kept.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { MotionMeter, emptyMotion, mergeMotion, motionBefore, summarizeMotion, type MotionCounts, type MotionSummary } from '../../src/bots/motion'
import { decodeCmd, type WireCmd } from '../../src/net/stream'
import { setTickRate } from '../../src/sim/types'
import type { BotDifficulty, PlayerId, PlayerInput, PlayerSlot, SimState } from '../../src/sim/types'

const argv = process.argv.slice(2).filter((a) => a !== '--')
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const REFERENCE = arg('reference', 'BeFlat')
const OUT = arg('out', '')
const paths: string[] = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) i++
  else paths.push(argv[i])
}
if (!paths.length) paths.push('media/replays')

/** commits on main searched for a netcode id, newest first */
const MAX_COMMITS = 400
/** net-id.mjs prints only when run by its real path, and the OS temp folder can be a symlink (macOS) */
const TMP = realpathSync(tmpdir())
const CACHE_FILE = join(TMP, 'brawlock-net-ids.json')
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const TIERS: BotDifficulty[] = ['dummy', 'easy', 'medium', 'hard', 'brutal', 'uber']
/** the measures that need pawn positions: null when a replay could not be re-simulated */
const POSITIONAL = ['reversalsPerSecond', 'freeReversalsPerSecond', 'dither', 'idle', 'clickFlip', 'flipsPerSecond', 'shortClick'] as const
const NET_ID = /^[0-9a-f]{12}$/
const RANGED = ['ordersPerSecond', 'castsPerSecond', ...POSITIONAL] as const

type Measures = { [K in keyof MotionSummary]: MotionSummary[K] | null }
type Range = [min: number, max: number] | null

/** What is read before a build is chosen. This checkout's decodeReplay rejects files from before the `hz` field. */
interface RawReplay {
  netId: string
  hz?: number
  date: number
  settings: { gameMode?: string; teamMode?: string }
  slots: PlayerSlot[]
  start: { tick: number; phase: string }
  endTick: number
  steps: [tick: number, inputs: [PlayerId, WireCmd[]][], ...rest: unknown[]][]
  hashes: [number, number][]
  rounds: [number, number][]
  kills: [number, PlayerId | null, PlayerId][]
}

/** What this script uses of a build's replay code. Old states are not this checkout's SimState,
 * but they carry everything the meter reads (pawn positions and walking, projectiles, teams). */
interface BuildModules {
  fmt: {
    decodeReplay(bytes: Uint8Array): Promise<{ netId: string; hz?: number; resyncs: [number, SimState][]; steps: [number, ...unknown[]][] } | null>
    decodeInputs(step: unknown): PlayerInput[]
  }
  player: {
    ReplayPlayer: new (data: unknown, netId: string) => {
      readonly playable: boolean
      readonly tick: number
      readonly done: boolean
      readonly state: SimState
      readonly desync: { tick: number } | null
      stepOnce(): unknown
    }
  }
  types: { TICK_HZ: number; setTickRate?: (hz: number) => void }
}

interface Build {
  commit: string
  tag: string | null
}

const temps: string[] = []
process.on('exit', () => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(TMP, prefix))
  temps.push(d)
  return d
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
const lines = (s: string) => s.split('\n').filter(Boolean)

function extract(commit: string, paths: string[], dir: string): void {
  const tar = execFileSync('git', ['archive', commit, ...paths], { cwd: REPO, maxBuffer: 1 << 30 })
  execFileSync('tar', ['-x', '-C', dir], { input: tar })
}

/** The commit's netcode id, from its own scripts/net-id.mjs; null before that script existed. */
function netIdOf(commit: string): string | null {
  // git archive fails on a path the commit lacks, and progressionCatalog.ts came after net-id.mjs
  const present = new Set(lines(git('ls-tree', '-r', '--name-only', '--full-name', commit, '--', 'scripts/net-id.mjs', 'src/game/progressionCatalog.ts')))
  if (!present.has('scripts/net-id.mjs')) return null
  const dir = tempDir('brawlock-netid-')
  try {
    extract(commit, ['src/sim', 'src/net', ...present], dir)
    const id = execFileSync(process.execPath, [join(dir, 'scripts/net-id.mjs'), dir], { encoding: 'utf8' }).trim()
    if (!NET_ID.test(id)) throw new Error(`scripts/net-id.mjs at ${commit} printed ${JSON.stringify(id)}`)
    return id
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** For each wanted netcode id, the build that has it: a release tag if one does, else the newest commit on main. */
function findBuilds(wanted: ReadonlySet<string>): Map<string, Build> {
  let cache: Record<string, string | null> = {}
  try {
    cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    // first run, or the temp folder was cleared
  }
  const tagOf = new Map<string, string>()
  const candidates: string[] = []
  for (const tag of lines(git('tag', '--list', 'v*', '--sort=-creatordate'))) {
    const commit = git('rev-list', '-n', '1', tag)
    if (!tagOf.has(commit)) tagOf.set(commit, tag)
    candidates.push(commit)
  }
  candidates.push(...lines(git('rev-list', `--max-count=${MAX_COMMITS}`, 'main')))
  const found = new Map<string, Build>()
  const seen = new Set<string>()
  for (const commit of candidates) {
    if (found.size === wanted.size) break
    if (seen.has(commit)) continue
    seen.add(commit)
    if (!(commit in cache)) cache[commit] = netIdOf(commit)
    const id = cache[commit]
    if (id && wanted.has(id) && !found.has(id)) found.set(id, { commit, tag: tagOf.get(commit) ?? null })
  }
  writeFileSync(CACHE_FILE, JSON.stringify(cache))
  return found
}

const loaded = new Map<string, Promise<BuildModules>>()
function modulesOf(commit: string): Promise<BuildModules> {
  let m = loaded.get(commit)
  if (!m) {
    const root = tempDir('brawlock-replay-')
    extract(commit, ['src'], root)
    m = (async () => ({
      fmt: await import(`${root}/src/game/replay/format.ts`),
      player: await import(`${root}/src/game/replay/player.ts`),
      types: await import(`${root}/src/sim/types.ts`),
    }))()
    loaded.set(commit, m)
  }
  return m
}

/** Re-simulates the replay on its build, metering every tick. */
async function simulate(build: Build, bytes: Uint8Array): Promise<{ hz: number; desync: number | null; counts: Map<PlayerId, MotionCounts> }> {
  const { fmt, player, types } = await modulesOf(build.commit)
  const d = await fmt.decodeReplay(bytes)
  if (!d) throw new Error(`the build at ${build.commit} cannot decode it`)
  // builds from before the rate setting ran at one fixed rate and stored no hz
  if (d.hz && types.setTickRate) types.setTickRate(d.hz)
  const hz = types.TICK_HZ
  if (d.hz && d.hz !== hz) throw new Error(`recorded at ${d.hz} Hz, its build runs at ${hz} Hz`)
  setTickRate(hz)
  const p = new player.ReplayPlayer(d, d.netId)
  if (!p.playable) throw new Error('its build refuses it')
  const steps = new Map(d.steps.map((s) => [s[0], s]))
  const resyncs = new Map(d.resyncs)
  const meter = new MotionMeter()
  while (!p.done) {
    const t = p.tick
    // the player swaps a resync state in before it steps
    const before = motionBefore(resyncs.get(t) ?? p.state)
    const rec = steps.get(t)
    const cmds = rec ? fmt.decodeInputs(rec) : []
    p.stepOnce()
    if (p.tick !== t + 1) throw new Error(`playback stopped at tick ${t}`)
    meter.tick(before, cmds, p.state)
  }
  return { hz, desync: p.desync?.tick ?? null, counts: new Map(meter.players().map((id) => [id, meter.counts(id)])) }
}

/**
 * Orders, casts and move-order gaps from the recorded inputs alone. A player's fight time runs
 * from each fight's start marker to their first death in it, else to the fight's last death (a
 * round ends when the last rival falls), else to the next fight. A fight without an order from
 * the player is left out (a final round's noncontenders watch it). Respawns are not followed, so
 * a respawning mode counts each player's first life per fight.
 */
function fromInputs(d: RawReplay, hz: number): Map<PlayerId, MotionCounts> {
  const fights = d.rounds.map(([t]) => t)
  // a recording that starts mid-fight has no marker for it
  if (d.start.phase === 'fight') fights.push(d.start.tick)
  fights.sort((a, b) => a - b)
  const spans = new Map<PlayerId, [number, number][]>(d.slots.map((s) => [s.id, []]))
  fights.forEach((start, i) => {
    const next = fights[i + 1] ?? d.endTick
    const deaths = d.kills.filter(([t]) => t >= start && t < next)
    const last = deaths.length ? Math.max(...deaths.map(([t]) => t)) : next
    for (const [id, own] of spans) own.push([start, deaths.find(([, , victim]) => victim === id)?.[0] ?? last])
  })
  const counts = new Map<PlayerId, MotionCounts>([...spans.keys()].map((id) => [id, emptyMotion()]))
  const lastMove = new Map<PlayerId, { tick: number; span: [number, number] }>()
  const played = new Set<[number, number]>()
  for (const [t, players] of d.steps) {
    for (const [id, wire] of players) {
      const span = spans.get(id)?.find(([a, b]) => t >= a && t < b)
      const c = counts.get(id)
      if (!span || !c) continue
      for (const w of wire) {
        const cmd = decodeCmd(w)
        if (cmd?.kind === 'cast') c.casts++
        if (cmd?.kind !== 'move' && cmd?.kind !== 'stop') continue
        c.orders++
        played.add(span)
        if (cmd.kind !== 'move') continue
        c.moves++
        const prev = lastMove.get(id)
        if (prev?.span === span) c.moveGaps.push((t - prev.tick) / hz)
        lastMove.set(id, { tick: t, span })
      }
    }
  }
  for (const [id, own] of spans) {
    const c = counts.get(id)!
    c.seconds = own.filter((span) => played.has(span)).reduce((n, [a, b]) => n + (b - a), 0) / hz
    if (c.seconds === 0) counts.delete(id)
  }
  return counts
}

function readRaw(bytes: Uint8Array): RawReplay | null {
  try {
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes
    const v = JSON.parse(new TextDecoder().decode(raw))
    return v?.format === 'brawlock-replay' && typeof v.netId === 'string' ? v : null
  } catch {
    return null
  }
}

function measuresOf(c: MotionCounts, simulated: boolean): Measures {
  const m: Measures = summarizeMotion(c)
  if (!simulated) for (const k of POSITIONAL) m[k] = null
  return m
}

interface Entry {
  replay: string
  group: string
  name: string
  kind: PlayerSlot['kind']
  tier: BotDifficulty | null
  simulated: boolean
  counts: MotionCounts
  measures: Measures
}

/** Pooled over a group's matches; the positional measures only over the re-simulated ones. */
function pool(entries: Entry[]): Measures {
  const merge = (es: Entry[]) => es.reduce((into, e) => mergeMotion(into, e.counts), emptyMotion())
  const m: Measures = summarizeMotion(merge(entries))
  const sim = entries.filter((e) => e.simulated)
  if (sim.length < entries.length) {
    const positional = sim.length ? summarizeMotion(merge(sim)) : null
    for (const k of POSITIONAL) m[k] = positional ? positional[k] : null
  }
  return m
}

function spread(xs: (number | null | undefined)[]): Range {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? [Math.min(...v), Math.max(...v)] : null
}

function ranges(entries: Entry[]): Record<(typeof RANGED)[number], Range> & { moveGaps: Range[] } {
  const out = {} as Record<(typeof RANGED)[number], Range>
  for (const k of RANGED) out[k] = spread(entries.map((e) => e.measures[k]))
  return { ...out, moveGaps: [0, 1, 2].map((i) => spread(entries.map((e) => e.measures.moveGaps?.[i]))) }
}

// ---------------------------------------------------------------------------

const files: string[] = []
for (const p of paths) {
  if (statSync(p).isDirectory()) files.push(...readdirSync(p).filter((f) => f.endsWith('.brawlock')).sort().map((f) => join(p, f)))
  else files.push(p)
}
const raws = files.map((f) => {
  const bytes = new Uint8Array(readFileSync(f))
  return { file: f, bytes, raw: readRaw(bytes) }
})
const skipped = raws.filter((r) => !r.raw).map((r) => basename(r.file))
for (const f of skipped) console.warn(`not a replay, skipped: ${f}`)
const started = Date.now()
const builds = findBuilds(new Set(raws.flatMap((r) => (r.raw ? [r.raw.netId] : []))))
console.log(`# build lock: ${builds.size} build(s) found (${((Date.now() - started) / 1000).toFixed(1)} s)`)

const f = (x: number | null | undefined, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : '-')
const HEAD = 'player          kind  tier    fight-s orders/s casts/s rev/s  free  dither idle  flip  flips/s short  gaps p10/p50/p90'
const row = (label: string, kind: string, tier: string, m: Measures) =>
  `${label.padEnd(15)} ${kind.padEnd(5)} ${tier.padEnd(7)} ${f(m.seconds, 0).padStart(7)} ${f(m.ordersPerSecond).padStart(8)} ${f(m.castsPerSecond).padStart(7)} ${f(m.reversalsPerSecond).padStart(5)} ${f(m.freeReversalsPerSecond).padStart(5)} ${f(m.dither, 3).padStart(6)} ${f(m.idle).padStart(5)} ${f(m.clickFlip, 3).padStart(5)} ${f(m.flipsPerSecond).padStart(7)} ${f(m.shortClick).padStart(5)}  ${(m.moveGaps ?? []).map((g) => f(g)).join('/').padStart(14)}`

const replays: unknown[] = []
const groups = new Map<string, Entry[]>()
for (const { file, bytes, raw } of raws) {
  if (!raw) continue
  const build = builds.get(raw.netId) ?? null
  let hz: number
  let desync: number | null = null
  let counts: Map<PlayerId, MotionCounts>
  const t0 = Date.now()
  if (build) {
    ;({ hz, desync, counts } = await simulate(build, bytes))
  } else {
    // the state hash interval is 5 s at every rate, so its spacing gives the rate of files without hz
    hz = raw.hz ?? (raw.hashes.length > 1 ? (raw.hashes[1][0] - raw.hashes[0][0]) / 5 : NaN)
    if (!Number.isFinite(hz)) {
      console.warn(`no build and no tick rate, skipped: ${basename(file)}`)
      skipped.push(basename(file))
      continue
    }
    console.warn(`no build with netcode id ${raw.netId} in the tags or the last ${MAX_COMMITS} commits on main: ${basename(file)} measured from its inputs only`)
    counts = fromInputs(raw, hz)
  }
  if (desync !== null) console.warn(`DESYNC at tick ${desync}: ${basename(file)}`)
  const players: unknown[] = []
  const slots = [...raw.slots].sort((a, b) => (a.kind === b.kind ? a.id - b.id : a.kind === 'human' ? -1 : 1))
  console.log(`\n${basename(file)}  ${build ? (build.tag ?? build.commit.slice(0, 7)) : 'inputs only'}  ${hz} Hz  ${raw.settings.gameMode}  desync ${desync ?? 'none'}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  console.log(HEAD)
  for (const s of slots) {
    const c = counts.get(s.id)
    if (!c) continue
    const tier = s.kind === 'bot' ? (s.difficulty ?? null) : null
    const entry: Entry = { replay: basename(file), group: s.kind === 'bot' ? `${tier} bots` : s.name, name: s.name, kind: s.kind, tier, simulated: !!build, counts: c, measures: measuresOf(c, !!build) }
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry])
    players.push({ name: s.name, kind: s.kind, tier, ...entry.measures })
    console.log(row(s.name + (s.name === REFERENCE && s.kind === 'human' ? '*' : ''), s.kind, tier ?? '', entry.measures))
  }
  replays.push({
    file: basename(file),
    recorded: new Date(raw.date).toISOString(),
    netId: raw.netId,
    build,
    hz,
    gameMode: raw.settings.gameMode ?? null,
    teamMode: raw.settings.teamMode ?? null,
    source: build ? 'resimulated' : 'inputs',
    desync,
    players,
  })
}

const order = (g: string, es: Entry[]) => (es[0].kind === 'bot' ? `1${TIERS.indexOf(es[0].tier!)}` : `0${g === REFERENCE ? '' : g}`)
const sorted = [...groups].sort(([a, ea], [b, eb]) => order(a, ea).localeCompare(order(b, eb)))
const hasReference = groups.get(REFERENCE)?.[0].kind === 'human'
if (!hasReference) console.warn(`reference ${REFERENCE} is not a human in these replays`)
console.log(`\n# pooled per player (bots per tier); ranges are min-max over matches${hasReference ? `; * = reference` : ''}`)
console.log(HEAD)
const players: Record<string, unknown> = {}
for (const [g, es] of sorted) {
  const pooled = pool(es)
  const r = ranges(es)
  players[g] = { kind: es[0].kind, tier: es[0].tier, matches: new Set(es.map((e) => e.replay)).size, values: es.length, pooled, ranges: r }
  console.log(row(g + (g === REFERENCE ? '*' : ''), es[0].kind, es[0].tier ?? '', pooled))
  const rr = (v: Range, d = 2) => (v ? `${f(v[0], d)}-${f(v[1], d)}` : '-')
  console.log(`  ${es.length} match values: orders ${rr(r.ordersPerSecond)}  rev ${rr(r.reversalsPerSecond)}  free ${rr(r.freeReversalsPerSecond)}  dither ${rr(r.dither, 3)}  flip ${rr(r.clickFlip, 3)}  flips/s ${rr(r.flipsPerSecond)}  gaps ${r.moveGaps.map((v) => rr(v)).join(' / ')}`)
}

if (OUT) {
  const doc = {
    measured: new Date().toISOString().slice(0, 10),
    command: `npx vite-node scripts/bots/replay-motion.ts -- ${argv.join(' ')}`,
    meter: 'src/bots/motion.ts',
    reference: hasReference ? REFERENCE : null,
    groups: 'humans by name, bots by tier',
    ranges: 'min and max of the per-match values; for a bot tier every bot of it in every match is one value',
    skipped,
    replays,
    players,
  }
  // 3 decimals; NaN (no data) as null
  const round = (_: string, v: unknown) => (typeof v === 'number' ? (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null) : v)
  writeFileSync(OUT, JSON.stringify(doc, round, 2) + '\n')
  console.log(`\nwrote ${OUT}`)
}
