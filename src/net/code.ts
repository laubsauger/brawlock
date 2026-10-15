/**
 * Room codes: five letters a host can read out or paste in a chat ("KRZBW").
 * The alphabet has no I or O (they read as 1 and 0). The host registers the
 * PeerJS id `brawlock-<CODE>`, so the code alone is enough to join.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const CODE_LENGTH = 5
/** typed codes are accepted at 4..6 letters so a future length change stays joinable */
const CODE_MIN = 4
const CODE_MAX = 6
const PEER_PREFIX = 'brawlock-'

/** Uniform integer in [0, n) from crypto, by rejection sampling (no modulo bias). */
function cryptoInt(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % n
  }
}

/** A fresh random code. `randomInt(n)` returns an integer in [0, n). */
export function newRoomCode(randomInt: (n: number) => number = cryptoInt): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

/**
 * Normalize what a person typed or pasted ("krz-bw", "K R Z B W", or a whole
 * invite link) to a code, or say what is wrong with it.
 */
export function parseRoomCode(input: string): { code: string } | { problem: string } {
  let raw = input.trim()
  const fromLink = raw.match(/[?&]room=([^&#\s]*)/i)
  if (fromLink) {
    try {
      raw = decodeURIComponent(fromLink[1])
    } catch {
      raw = fromLink[1]
    }
  }
  const s = raw.replace(/[\s-]+/g, '').toUpperCase()
  if (!s) return { problem: 'Enter the room code from the host.' }
  // read out loud, O / 0 and I / 1 get mixed up: none of them is ever in a code
  if (/[IO01]/.test(s)) return { problem: 'Room codes never contain I or O (or 0 and 1). Check the code with the host.' }
  if (!/^[A-Z]+$/.test(s)) return { problem: 'Room codes are letters only.' }
  if (s.length < CODE_MIN || s.length > CODE_MAX) {
    return { problem: `Room codes have ${CODE_LENGTH} letters; this one has ${s.length}.` }
  }
  return { code: s }
}

/** Invite link: `pageUrl` with `?room=CODE`. */
export function roomLink(pageUrl: string, code: string): string {
  const u = new URL(pageUrl)
  u.searchParams.delete('join')
  u.searchParams.set('room', code)
  return u.toString()
}

/** The valid code in a query string (`location.search`), or null. */
export function codeFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('room')
  if (!raw) return null
  const r = parseRoomCode(raw)
  return 'code' in r ? r.code : null
}

/** PeerJS id the host registers for a code. */
export function peerIdForCode(code: string): string {
  return PEER_PREFIX + code
}
