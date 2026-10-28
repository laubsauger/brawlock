import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { accountsEnabled } from '../../game/account'
import { useAccount } from '../../game/accountState'
import { getDeviceId } from '../../game/device'
import { online, session } from '../../game/session'
import { useGame } from '../../game/store'
import { parsePresence, PRESENCE_INTERVAL_MS, PRESENCE_REGIONS, PRESENCE_TTL_MS, type PresenceSnapshot } from '../../shared/presence'
import { pickRegion, regionStatus } from './servers'

const usePresence = create<{ snapshot: PresenceSnapshot | null; at: number }>(() => ({ snapshot: null, at: 0 }))
declare const __BUILD_ID__: string
declare const __NET_ID__: string

/** The region this browser counts toward (presence, global chat): its game's, else the one it would host in. */
export function usePresenceRegion(): string | undefined {
  const choice = useGame((s) => s.settings.serverRegion)
  const [statuses, setStatuses] = useState(regionStatus)
  useEffect(() => online.subscribe(() => setStatuses(online.status())), [])
  return session.region()?.id ?? pickRegion(statuses, choice)?.id
}

/** One small heartbeat for the whole app, including menus, local games and replays. */
export function useOnlinePresence(): void {
  const screen = useGame((s) => s.screen)
  const accountId = useAccount((s) => s.player?.id)
  const region = usePresenceRegion()
  useEffect(() => {
    if (!accountsEnabled || !region || !PRESENCE_REGIONS.some((id) => id === region)) return
    let stopped = false
    let busy = false
    const controller = new AbortController()
    async function beat() {
      if (busy || stopped) return
      busy = true
      try {
        const response = await fetch('/api/presence', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: getDeviceId(), region, build: __BUILD_ID__, net: __NET_ID__, screen }) })
        if (!response.ok) throw new Error('Online population is unavailable.')
        const snapshot = parsePresence(await response.json())
        if (!stopped) usePresence.setState({ snapshot, at: Date.now() })
      } catch {
        if (!stopped) usePresence.setState({ snapshot: null, at: 0 })
      } finally { busy = false }
    }
    void beat()
    const timer = window.setInterval(() => void beat(), PRESENCE_INTERVAL_MS)
    return () => { stopped = true; controller.abort(); window.clearInterval(timer) }
  }, [region, accountId, screen])
}

export function useOnlinePopulation(): PresenceSnapshot | null {
  const snapshot = usePresence((s) => s.snapshot)
  const at = usePresence((s) => s.at)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), PRESENCE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])
  return snapshot && Date.now() - at < PRESENCE_TTL_MS && now - at < PRESENCE_TTL_MS ? snapshot : null
}
