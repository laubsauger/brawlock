/**
 * Client side of the global menu chat (net/globalChat.ts, server/chat.mjs): the long-poll feed,
 * sending and reporting, and the players this browser has muted for itself.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { GLOBAL_CHAT_WAIT_MS, mergeGlobalChat, readGlobalChat, readGlobalLine, type GlobalChatLine } from '../../net/globalChat'
import { siteApi, siteCredentials } from '../../lib/site'

interface GlobalChatState {
  epoch: string
  version: number
  /** highest id a read delivered; own lines arrive early and never move it */
  cursor: number
  lines: GlobalChatLine[]
  live: boolean
}
export const useGlobalChat = create<GlobalChatState>(() => ({ epoch: '', version: -1, cursor: 0, lines: [], live: false }))

/** reads start at most this often; a held read that answers late starts the next at once */
const READ_SPACING_MS = 2000
const RETRY_MS = 10_000
const BUSY_RETRY_MS = 30_000

/** Long-polls the channel while `enabled` and the tab is visible. */
export function useGlobalChatFeed(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let waiting = false
    let timer = 0
    const controller = new AbortController()
    async function poll() {
      if (stopped) return
      if (document.hidden) { waiting = true; return }
      const started = Date.now()
      const { epoch, version, cursor } = useGlobalChat.getState()
      let delay = READ_SPACING_MS
      try {
        const query = new URLSearchParams({ epoch, after: String(cursor), v: String(version) })
        const response = await fetch(siteApi(`/api/chat?${query}`), { credentials: siteCredentials, cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(GLOBAL_CHAT_WAIT_MS + 5000)]) })
        if (response.status === 429) delay = BUSY_RETRY_MS
        else {
          const read = response.ok ? readGlobalChat(await response.json()) : null
          if (!read) throw new Error('Global chat is unavailable.')
          if (stopped) return
          useGlobalChat.setState((s) => ({ epoch: read.epoch, version: read.version, live: true,
            cursor: Math.max(read.full ? 0 : s.cursor, ...read.lines.map((line) => line.id)),
            lines: mergeGlobalChat(s.lines, read) }))
        }
      } catch {
        if (stopped) return
        useGlobalChat.setState({ live: false })
        delay = RETRY_MS
      }
      timer = window.setTimeout(() => void poll(), Math.max(0, started + delay - Date.now()))
    }
    const visible = () => {
      if (document.hidden || !waiting) return
      waiting = false
      void poll()
    }
    document.addEventListener('visibilitychange', visible)
    void poll()
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [enabled])
}

async function postChat(path: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  try {
    const response = await fetch(siteApi(path), { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const reply = await response.json().catch(() => null) as Record<string, unknown> | null
    return { ok: response.ok, body: reply && typeof reply === 'object' ? reply : null }
  } catch { return { ok: false, body: null } }
}

const failure = (body: Record<string, unknown> | null, fallback: string) => typeof body?.error === 'string' ? body.error : fallback

/** Null when sent, else what to tell the player; the draft stays until a send succeeds. */
export async function sendGlobalChat(text: string, region: string): Promise<string | null> {
  const { ok, body } = await postChat('/api/chat', { text, region })
  const line = ok ? readGlobalLine(body?.line) : null
  if (line) {
    useGlobalChat.setState((s) => ({ lines: mergeGlobalChat(s.lines, { full: false, lines: [line], hidden: [] }) }))
    return null
  }
  if (body && 'until' in body) return body.until === null ? 'You can no longer post in global chat.'
    : `You are muted in global chat until ${new Date(body.until as number).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`
  return failure(body, 'Chat is unavailable. Your message has not been sent.')
}

/** Null when reported, else the reason it was not. */
export async function reportGlobalChat(id: number): Promise<string | null> {
  const { ok, body } = await postChat('/api/chat/report', { id })
  return ok ? null : failure(body, 'The report could not be sent. Try again.')
}

const MUTE_KEY = 'brawlock.globalChat.muted'
const MAX_MUTES = 200
function loadMutes(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MUTE_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(-MAX_MUTES) : []
  } catch { return [] }
}
/** Players muted in this browser only (sender handles); everyone else still sees them. */
export const useChatMutes = create<{ muted: string[] }>(() => ({ muted: loadMutes() }))
function saveMutes(muted: string[]): void {
  useChatMutes.setState({ muted })
  try { localStorage.setItem(MUTE_KEY, JSON.stringify(muted)) } catch { /* the mute lasts this visit */ }
}
export const muteSender = (sender: string): void => saveMutes([...useChatMutes.getState().muted.filter((s) => s !== sender), sender].slice(-MAX_MUTES))
export const unmuteAll = (): void => saveMutes([])
