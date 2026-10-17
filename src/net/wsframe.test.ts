import { describe, expect, it } from 'vitest'
import { FrameDecoder, OP_CONT, OP_PING, OP_TEXT, decodeText, encodeFrame, encodeMaskedFrame, encodeText } from './wsframe'

const enc = new TextEncoder()
const MASK = [0x12, 0x34, 0x56, 0x78]

describe('WebSocket framing (dedicated server)', () => {
  /** Why: the server speaks raw RFC 6455; a framing bug corrupts or stalls every message. */
  it('decodes masked client frames of every length class, split across TCP chunks', () => {
    for (const n of [0, 5, 125, 126, 4000, 65535, 70000]) {
      const text = 'x'.repeat(n)
      const frame = encodeMaskedFrame(OP_TEXT, enc.encode(text), MASK)
      const d = new FrameDecoder(1 << 20)
      const got: string[] = []
      // worst case: one byte per chunk for short frames, odd chunk sizes for long ones
      const step = n < 200 ? 1 : 997
      for (let i = 0; i < frame.length; i += step) for (const m of d.push(frame.subarray(i, i + step))) got.push(decodeText(m.payload))
      expect(got).toEqual([text])
    }
  })

  it('joins fragmented messages and passes control frames in between', () => {
    const d = new FrameDecoder()
    const a = encodeMaskedFrame(OP_TEXT, enc.encode('hel'), MASK, false)
    const ping = encodeMaskedFrame(OP_PING, enc.encode('p'), MASK)
    const b = encodeMaskedFrame(OP_CONT, enc.encode('lo'), MASK, true)
    const all = new Uint8Array([...a, ...ping, ...b])
    const msgs = d.push(all)
    expect(msgs.map((m) => [m.opcode, decodeText(m.payload)])).toEqual([
      [OP_PING, 'p'],
      [OP_TEXT, 'hello'],
    ])
  })

  /** Why: the server must not trust clients: unmasked or oversized frames end the connection. */
  it('rejects unmasked client frames and messages over the limit', () => {
    expect(() => new FrameDecoder().push(encodeText('hi'))).toThrow(/masked/)
    const big = encodeMaskedFrame(OP_TEXT, new Uint8Array(2000), MASK)
    expect(() => new FrameDecoder(1000).push(big)).toThrow(/too large/)
  })

  it('encodes server frames with the right length header', () => {
    expect([...encodeFrame(OP_TEXT, new Uint8Array(3)).subarray(0, 2)]).toEqual([0x81, 3])
    expect([...encodeFrame(OP_TEXT, new Uint8Array(300)).subarray(0, 4)]).toEqual([0x81, 126, 1, 44])
    const big = encodeFrame(OP_TEXT, new Uint8Array(70000))
    expect(big[1]).toBe(127)
    expect((big[8] << 8) | big[9]).toBe(70000 & 0xffff)
    expect(big.length).toBe(70000 + 10)
  })
})
