import type { PublicRoom } from '../../net/online'

const ACTIVITY = { warmup: 'Preparing', shop: 'Shopping', fight: 'Fighting', roundEnd: 'Between rounds', gameOver: 'Match finished' }

export function roomActivity(room: Pick<PublicRoom, 'phase' | 'progress' | 'rankedRounds'>): { label: string; detail: string | null } {
  if (room.phase === 'lobby') return { label: 'Waiting', detail: null }
  const progress = room.progress
  const label = room.phase === 'results' ? 'Between matches' : progress ? ACTIVITY[progress.phase] : 'In a match'
  if (!progress) return { label, detail: null }
  const round = progress.final ? 'Final brawl' : `Round ${progress.round}${room.rankedRounds ? `/${room.rankedRounds}` : ''}`
  const time = `${Math.floor(progress.elapsedSeconds / 60)}:${String(progress.elapsedSeconds % 60).padStart(2, '0')}`
  return { label, detail: `${round} · ${time} elapsed` }
}
