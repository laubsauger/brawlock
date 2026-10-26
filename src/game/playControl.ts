import { create } from 'zustand'
import { PlayControl, type PlayConflict, type PlayTarget } from '../net/playControl'
import { getDeviceId } from './device'
import { controllerKey } from './clientKey'
import { SITE_URL, siteApi, siteCredentials } from '../lib/site'

export const usePlayControl = create<{ conflict: PlayConflict | null }>(() => ({ conflict: null }))
// A build hosted elsewhere (itch.io) has no sign-in but still needs the site's guest permission: servers require it.
export const playControlEnabled = import.meta.env.VITE_ACCOUNTS_ENABLED === 'true' || SITE_URL !== null
const TARGET_KEY = 'brawlock.active-game.v1'
let channel: BroadcastChannel | null = null
const messages = () => channel ??= new BroadcastChannel('brawlock.game-control.v1')
let lost: (message: string, transfer: boolean) => void = () => { throw new Error('Game control is not connected to the session.') }
let resume: (target: PlayTarget) => Promise<unknown> = async () => { throw new Error('Game resume is not connected to the session.') }

export function connectPlayControl(handlers: { lost: typeof lost; resume: typeof resume }) { lost = handlers.lost; resume = handlers.resume }

export const playControl = new PlayControl({
  enabled: playControlEnabled, now: () => performance.now(),
  async request(body, keepalive) {
    const response = await fetch(siteApi('/api/play'), { method: 'POST', credentials: siteCredentials, cache: 'no-store', keepalive,
      signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, device: getDeviceId(), controller: controllerKey() }) })
    const result = await response.json()
    if (!response.ok && response.status !== 409) throw new Error(typeof result.error === 'string' ? result.error : 'Game session service is unavailable.')
    return result
  },
  async lock(wait) {
    if (!navigator.locks) throw new Error('This browser needs Web Locks support to play. Update your desktop browser.')
    return new Promise<(() => void) | null>((resolve, reject) => {
      const options = wait ? { signal: AbortSignal.timeout(15000) } : { ifAvailable: true }
      void navigator.locks.request('brawlock.active-game.v1', options, async (lock) => {
        if (!lock) { resolve(null); return }
        await new Promise<void>((release) => resolve(release))
      }).catch(reject)
    })
  },
  localTarget() {
    const entry = JSON.parse(localStorage.getItem(TARGET_KEY) ?? 'null') as { target?: PlayTarget } | null
    if (!entry?.target) throw new Error('Another game is opening in this browser. Try again in a moment.')
    return entry.target
  },
  publish(target) {
    if (target) localStorage.setItem(TARGET_KEY, JSON.stringify({ owner: controllerKey(), target }))
    else {
      const entry = JSON.parse(localStorage.getItem(TARGET_KEY) ?? 'null') as { owner?: string } | null
      if (entry?.owner === controllerKey()) localStorage.removeItem(TARGET_KEY)
    }
  },
  listen(yieldGame) {
    const receive = (event: MessageEvent) => { if (event.data === 'yield') yieldGame() }
    messages().addEventListener('message', receive)
    return () => messages().removeEventListener('message', receive)
  },
  yieldOthers: () => messages().postMessage('yield'),
  every(fn, ms) {
    // A background hosting tab must renew even when window timers are throttled.
    const url = URL.createObjectURL(new Blob(['onmessage=e=>setInterval(()=>postMessage(null),e.data)'], { type: 'application/javascript' }))
    const worker = new Worker(url)
    worker.onmessage = fn; worker.postMessage(ms)
    return () => { worker.terminate(); URL.revokeObjectURL(url) }
  },
  cancel: (timer) => (timer as () => void)(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  lost: (message, transfer) => lost(message, transfer), conflict: (conflict) => usePlayControl.setState({ conflict }), resume: (target) => resume(target),
})

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { void playControl.release().catch(() => {}) })
