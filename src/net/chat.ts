/** Room chat is reliable session traffic, independent of simulation and replays. */
export const MAX_CHAT_LENGTH = 240
export const CHAT_HISTORY_LIMIT = 50

export interface ChatLine {
  id: number
  player: number
  name: string
  color: number
  text: string
}

export type ChatSendResult = 'sent' | 'invalid' | 'limited' | 'unavailable'

export function chatText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_CHAT_LENGTH) return null
  const text = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  return text || null
}

/** Validate host messages as well: malformed traffic must never enter the UI. */
export function readChatLine(value: unknown): ChatLine | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!Number.isSafeInteger(v.id) || (v.id as number) < 1 || !Number.isInteger(v.player) || (v.player as number) < 0 || (v.player as number) >= 10) return null
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 32) return null
  if (!Number.isInteger(v.color) || (v.color as number) < 0 || (v.color as number) > 0xffffff) return null
  const text = chatText(v.text)
  return text ? { id: v.id as number, player: v.player as number, name: v.name, color: v.color as number, text } : null
}
