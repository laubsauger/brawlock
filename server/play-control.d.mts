import type { PlayTarget } from '../src/net/playControl'
export const PLAY_TTL_MS: number
export const PLAY_SCHEMA: string
export function playTarget(value: unknown): PlayTarget
export interface PlayClock { id: string; expiresAt: number; serverTime: number }
export interface PlayActor { device: string; controller: string; userId: string | null }
export function createPlayControl(db: unknown, opts?: { now?: () => number }): {
  acquire(actor: PlayActor, target: PlayTarget): ({ ok: true; token: string } & PlayClock) | { ok: false; conflict: import('../src/net/playControl').PlayConflict }
  heartbeat(token: string, target: PlayTarget, actor: PlayActor): ({ ok: true } & PlayClock) | { ok: false }
  takeover(actor: PlayActor, id: string): { ok: true }
  release(token: string): void
  attach(token: string, region: string, instance: string, room: string, accountId: string | null): { ok: true; connection: string } & PlayClock
  check(token: string, connection: string): ({ ok: true } & PlayClock) | { ok: false }
  detach(region: string, instance: string, connection: string): void
  register(region: string, instance: string): void
}
