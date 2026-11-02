/**
 * Bot-only Wild frequencies (docs/moonshot/specs/wild.md, How it would be tested 1 and 2): per
 * omen against classic, the first knockout, the round's length, the share of deaths in the round's
 * first half, the Brutal seats' win share and reactions per round. Six bots (two each of Medium,
 * Hard and Brutal), free for all, eight rounds a match, the omen forced every round.
 *   npm run bots:wild -- [roundsPerCondition=40] [classic,bloodMoon,...]
 */
import { createBot } from '../../src/bots/index'
import { DEFAULT_SETTINGS, createMatch, step } from '../../src/sim/index'
import { TICK_HZ, type BotDifficulty, type PlayerSlot, type SimState } from '../../src/sim/types'

const args = process.argv.slice(2).filter((a) => a !== '--')
const PER = Number(args[0] ?? 40)
const CONDS = (args[1] ?? 'classic,bloodMoon,slickStone,overcharge,suddenCollapse,meteorShower,pillarStorm').split(',')
const TIERS: BotDifficulty[] = ['medium', 'medium', 'hard', 'hard', 'brutal', 'brutal']
const ROUNDS_PER_MATCH = 8

interface Round { firstKo: number; length: number; early: number; deaths: number; brutalWin: number; reactions: Record<string, number> }

function play(cond: string, seed: number, want: number, out: Round[]): void {
  const slots: PlayerSlot[] = TIERS.map((d, i) => ({ id: i, name: `B${i}`, color: 0xffffff, team: i, kind: 'bot', difficulty: d }))
  const settings = { ...DEFAULT_SETTINGS, wild: cond !== 'classic', winScore: 99, shopSeconds: 4 }
  const s: SimState = createMatch(settings, slots, seed)
  const bots = slots.map((sl) => createBot(sl.id, sl.difficulty!, seed * 31 + sl.id))
  let start = -1
  let firstKo = -1
  let deaths: number[] = []
  let reactions: Record<string, number> = {}
  let rounds = 0
  for (let i = 0; i < 60 * 60 * TICK_HZ && rounds < Math.min(ROUNDS_PER_MATCH, want) && s.phase !== 'gameOver'; i++) {
    if (cond !== 'classic' && s.phase === 'shop') s.omen = cond as SimState['omen']
    step(s, bots.map((b) => ({ player: b.player, tick: s.tick, cmds: b.think(s) })))
    for (const e of s.events) {
      if (e.type === 'phase' && e.phase === 'fight') {
        start = s.tick
        firstKo = -1
        deaths = []
        reactions = {}
      } else if (e.type === 'death' && start >= 0) {
        if (firstKo < 0) firstKo = s.tick - start
        deaths.push(s.tick - start)
      } else if (e.type === 'reaction') {
        reactions[e.reaction] = (reactions[e.reaction] ?? 0) + 1
      } else if (e.type === 'roundWin' && start >= 0) {
        const length = s.tick - start
        const winnerTier = e.players.length === 1 ? TIERS[e.players[0]] : null
        out.push({ firstKo: firstKo / TICK_HZ, length: length / TICK_HZ, early: deaths.filter((d) => d < length / 2).length, deaths: deaths.length, brutalWin: winnerTier === 'brutal' ? 1 : 0, reactions })
        rounds++
        start = -1
      }
    }
  }
}

const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN }
const t0 = Date.now()
for (const cond of CONDS) {
  const rounds: Round[] = []
  for (let seed = 1; rounds.length < PER; seed++) play(cond, seed * 7 + 3, PER - rounds.length, rounds)
  const r = (k: string) => rounds.reduce((n, x) => n + (x.reactions[k] ?? 0), 0) / rounds.length
  const deaths = rounds.reduce((n, x) => n + x.deaths, 0)
  console.log(JSON.stringify({
    cond, rounds: rounds.length,
    firstKoMedian: +median(rounds.map((x) => x.firstKo)).toFixed(1),
    lengthMedian: +median(rounds.map((x) => x.length)).toFixed(1),
    earlyDeathShare: +(rounds.reduce((n, x) => n + x.early, 0) / deaths).toFixed(2),
    brutalWinShare: +(rounds.reduce((n, x) => n + x.brutalWin, 0) / rounds.length).toFixed(2),
    reactionsPerRound: { shatter: +r('shatter').toFixed(2), nova: +r('nova').toFixed(2), fork: +r('fork').toFixed(2) },
    secs: Math.round((Date.now() - t0) / 1000),
  }))
}
