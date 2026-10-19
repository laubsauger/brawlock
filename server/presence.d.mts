import type { PresenceSnapshot } from '../src/shared/presence'
export function createPresence(opts?: { now?: () => number; maxDevices?: number; perIp?: number }): {
  snapshot(): PresenceSnapshot
  beat(body: unknown, accountId: string | null, ip: string):
    | { status: 200; body: PresenceSnapshot; error?: never }
    | { status: 400 | 429; error: string; body?: never }
}
