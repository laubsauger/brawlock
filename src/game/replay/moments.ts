/**
 * The moments of a recorded match (docs/moonshot/specs/moments.md): the replay re-simulated
 * through a fresh moments engine, so the results reel and a server name what the live client
 * named. Like playback, it needs the process at the replay's rate (`data.hz`).
 */
import { MomentsEngine, type Moment } from '../moments'
import type { ReplayData } from './format'
import { ReplayPlayer } from './player'

/** Every moment of the replay at once; null when this build cannot play it. */
export function momentsOfReplaySync(data: ReplayData, netId: string): Moment[] | null {
  const player = new ReplayPlayer(data, netId)
  if (!player.playable) return null
  const engine = new MomentsEngine()
  while (!player.done) engine.update(player.stepOnce(), player.state)
  return engine.all().slice()
}

/**
 * The same, in slices of about `budgetMs` so the main thread keeps drawing frames
 * (a ten-warlock match is a few seconds of simulation).
 */
export async function momentsOfReplay(data: ReplayData, netId: string, budgetMs = 8): Promise<Moment[] | null> {
  const player = new ReplayPlayer(data, netId)
  if (!player.playable) return null
  const engine = new MomentsEngine()
  while (!player.done) {
    const until = performance.now() + budgetMs
    while (!player.done && performance.now() < until) engine.update(player.stepOnce(), player.state)
    if (!player.done) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return engine.all().slice()
}
