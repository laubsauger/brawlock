/**
 * Global chat in the main menu (server/chat.mjs): one channel for every signed-in player, kept
 * in the account service's memory. Clients long-poll it; lines carry the sender's region so the
 * menu can filter by it.
 */
import { chatText } from './chat'

/** lines the service keeps; older ones fall off */
export const GLOBAL_CHAT_HISTORY = 100
/** a read with nothing new waits this long for a change (under nginx's 20 s proxy timeout) */
export const GLOBAL_CHAT_WAIT_MS = 15_000
/** this many different accounts reporting a line hide it for everyone until an operator looks */
export const GLOBAL_CHAT_REPORTS_TO_HIDE = 3

export interface GlobalChatLine {
  id: number
  at: number
  /** opaque and stable per account, for muting; never the account id */
  sender: string
  name: string
  /** the account's player color, null when it has none */
  color: number | null
  region: string
  text: string
}

/** One read: new lines after the client's cursor, or every line when `full`. */
export interface GlobalChatRead {
  /** changes when the service restarts; line ids start over then */
  epoch: string
  version: number
  full: boolean
  lines: GlobalChatLine[]
  /** lines hidden since (reports, operator): drop them */
  hidden: number[]
}

const SENDER = /^[0-9a-f]{16}$/
const EPOCH = /^[0-9a-f]{8}$/

export function readGlobalLine(value: unknown): GlobalChatLine | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!Number.isSafeInteger(v.id) || (v.id as number) < 1 || !Number.isSafeInteger(v.at) || (v.at as number) < 0) return null
  if (typeof v.sender !== 'string' || !SENDER.test(v.sender) || typeof v.region !== 'string' || !/^[a-z-]{1,16}$/.test(v.region)) return null
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 32) return null
  if (v.color !== null && (!Number.isInteger(v.color) || (v.color as number) < 0 || (v.color as number) > 0xffffff)) return null
  const text = chatText(v.text)
  return text ? { id: v.id as number, at: v.at as number, sender: v.sender, name: v.name, color: v.color as number | null, region: v.region, text } : null
}

/** Validate the service's answer as well: malformed traffic must never enter the UI. */
export function readGlobalChat(value: unknown): GlobalChatRead | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.epoch !== 'string' || !EPOCH.test(v.epoch) || !Number.isSafeInteger(v.version) || typeof v.full !== 'boolean') return null
  if (!Array.isArray(v.lines) || v.lines.length > GLOBAL_CHAT_HISTORY || !Array.isArray(v.hidden) || v.hidden.length > GLOBAL_CHAT_HISTORY) return null
  const lines = v.lines.map(readGlobalLine)
  if (lines.some((line) => !line) || v.hidden.some((id) => !Number.isSafeInteger(id))) return null
  return { epoch: v.epoch, version: v.version as number, full: v.full, lines: lines as GlobalChatLine[], hidden: v.hidden as number[] }
}

/** The lines on screen after a read: in id order, no duplicates, hidden ones gone. */
export function mergeGlobalChat(current: readonly GlobalChatLine[], read: Pick<GlobalChatRead, 'full' | 'lines' | 'hidden'>): GlobalChatLine[] {
  const byId = new Map((read.full ? [] : current).map((line) => [line.id, line]))
  for (const line of read.lines) byId.set(line.id, line)
  for (const id of read.hidden) byId.delete(id)
  return [...byId.values()].sort((a, b) => a.id - b.id).slice(-GLOBAL_CHAT_HISTORY)
}
