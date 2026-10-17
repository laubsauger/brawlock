/**
 * Minimal RFC 6455 framing for the dedicated server (no dependency). The server
 * reads masked client frames and writes unmasked frames; text messages only (the
 * protocol is JSON), plus ping / pong / close. Pure functions on bytes so the
 * same code is tested in Vitest and run by server/ in Node.
 */

/** Magic string of the opening handshake: accept = base64(sha1(key + WS_GUID)). */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OP_CONT = 0x0
export const OP_TEXT = 0x1
export const OP_BINARY = 0x2
export const OP_CLOSE = 0x8
export const OP_PING = 0x9
export const OP_PONG = 0xa

/** A whole message (fragments joined) or a control frame. */
export interface WsMessage {
  opcode: number
  payload: Uint8Array
}

/** Server → client frame: FIN set, never masked. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10
  const out = new Uint8Array(head + n)
  out[0] = 0x80 | (opcode & 0x0f)
  if (n < 126) out[1] = n
  else if (n < 65536) {
    out[1] = 126
    out[2] = n >>> 8
    out[3] = n & 0xff
  } else {
    out[1] = 127
    // 53-bit safe: high word first
    const hi = Math.floor(n / 0x100000000)
    const lo = n >>> 0
    out[2] = hi >>> 24
    out[3] = (hi >>> 16) & 0xff
    out[4] = (hi >>> 8) & 0xff
    out[5] = hi & 0xff
    out[6] = lo >>> 24
    out[7] = (lo >>> 16) & 0xff
    out[8] = (lo >>> 8) & 0xff
    out[9] = lo & 0xff
  }
  out.set(payload, head)
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeText(text: string): Uint8Array {
  return encodeFrame(OP_TEXT, encoder.encode(text))
}

export function decodeText(payload: Uint8Array): string {
  return decoder.decode(payload)
}

/**
 * Incremental decoder for client → server frames. push() returns every complete
 * message in the bytes so far; throws on a protocol error (unmasked client frame,
 * oversized message, fragmented control frame), after which the connection must close.
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0)
  private parts: Uint8Array[] = []
  private partOpcode = -1
  private partBytes = 0

  constructor(private readonly maxMessageBytes = 1 << 20) {}

  push(chunk: Uint8Array): WsMessage[] {
    if (this.buf.length === 0) this.buf = chunk
    else {
      const b = new Uint8Array(this.buf.length + chunk.length)
      b.set(this.buf)
      b.set(chunk, this.buf.length)
      this.buf = b
    }
    const out: WsMessage[] = []
    for (;;) {
      const f = this.frame()
      if (!f) break
      if (f.opcode >= 0x8) {
        if (!f.fin) throw new Error('fragmented control frame')
        out.push({ opcode: f.opcode, payload: f.payload })
        continue
      }
      if (f.opcode !== OP_CONT) {
        if (this.partOpcode >= 0) throw new Error('new message inside a fragmented one')
        this.partOpcode = f.opcode
      } else if (this.partOpcode < 0) throw new Error('continuation without a message')
      this.partBytes += f.payload.length
      if (this.partBytes > this.maxMessageBytes) throw new Error('message too large')
      this.parts.push(f.payload)
      if (!f.fin) continue
      const msg = new Uint8Array(this.partBytes)
      let o = 0
      for (const p of this.parts) {
        msg.set(p, o)
        o += p.length
      }
      out.push({ opcode: this.partOpcode, payload: msg })
      this.parts = []
      this.partOpcode = -1
      this.partBytes = 0
    }
    return out
  }

  /** One frame off the front of the buffer, or null when incomplete. */
  private frame(): { fin: boolean; opcode: number; payload: Uint8Array } | null {
    const b = this.buf
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    if (b[0] & 0x70) throw new Error('reserved bits set')
    const opcode = b[0] & 0x0f
    if (!(b[1] & 0x80)) throw new Error('client frames must be masked')
    let len = b[1] & 0x7f
    let o = 2
    if (len === 126) {
      if (b.length < 4) return null
      len = (b[2] << 8) | b[3]
      o = 4
    } else if (len === 127) {
      if (b.length < 10) return null
      const hi = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0
      const lo = ((b[6] << 24) | (b[7] << 16) | (b[8] << 8) | b[9]) >>> 0
      len = hi * 0x100000000 + lo
      o = 10
    }
    if (len > this.maxMessageBytes) throw new Error('frame too large')
    if (b.length < o + 4 + len) return null
    const mask = b.subarray(o, o + 4)
    o += 4
    const payload = new Uint8Array(len)
    for (let i = 0; i < len; i++) payload[i] = b[o + i] ^ mask[i & 3]
    this.buf = b.subarray(o + len)
    return { fin, opcode, payload }
  }
}

/** Client-side frame (masked), for tests: what a browser would send. */
export function encodeMaskedFrame(opcode: number, payload: Uint8Array, mask: readonly number[], fin = true): Uint8Array {
  const n = payload.length
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10
  const out = new Uint8Array(head + 4 + n)
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  if (n < 126) out[1] = 0x80 | n
  else if (n < 65536) {
    out[1] = 0x80 | 126
    out[2] = n >>> 8
    out[3] = n & 0xff
  } else {
    out[1] = 0x80 | 127
    const lo = n >>> 0
    out[6] = lo >>> 24
    out[7] = (lo >>> 16) & 0xff
    out[8] = (lo >>> 8) & 0xff
    out[9] = lo & 0xff
  }
  out.set(mask.slice(0, 4), head)
  for (let i = 0; i < n; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3]
  return out
}
