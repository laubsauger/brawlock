import { describe, expect, it } from 'vitest'
import { chatText, readChatLine, MAX_CHAT_LENGTH } from './chat'
import { decode, encode } from './protocol'

const line = { id: 1, player: 2, name: 'Ash', color: 0xff5533, text: 'Good round 🔥' }
describe('room chat validation', () => {
  it('keeps Unicode and literal markup, normalizes whitespace, and rejects invalid or oversized input', () => {
    expect(chatText('  Good\nround\t🔥  ')).toBe('Good round 🔥')
    expect(chatText('<b>hello</b>')).toBe('<b>hello</b>')
    for (const invalid of [null, {}, 7, '', ' \n\t', 'x'.repeat(MAX_CHAT_LENGTH + 1)]) expect(chatText(invalid)).toBeNull()
    expect(chatText('x'.repeat(MAX_CHAT_LENGTH))).toHaveLength(MAX_CHAT_LENGTH)
  })
  it('accepts only bounded, complete host identities and copies no extra payload', () => {
    expect(readChatLine({ ...line, device: 'private', other: 10 })).toEqual(line)
    for (const patch of [{ id: 0 }, { id: 1.5 }, { player: -1 }, { player: 10 }, { color: -1 }, { color: 0x1000000 }, { name: '' }, { name: 'a'.repeat(33) }, { text: [] }]) expect(readChatLine({ ...line, ...patch })).toBeNull()
  })
  it('roundtrips each reliable chat message through the shared protocol', () => {
    for (const msg of [{ t: 'say', text: line.text }, { t: 'chat', line }, { t: 'chatlog', lines: [line] }] as const) expect(decode(encode(msg as Parameters<typeof encode>[0]))).toEqual(msg)
  })
})
