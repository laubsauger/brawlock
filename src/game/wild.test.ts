import { describe, expect, it } from 'vitest'
import { markReactionSeen, seenReactions } from './wild'
import type { KV } from './profile'

function memKV(): KV & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

/**
 * Why: a reaction's discovery card shows once, and the Spell library's Reactions fill in from
 * the same record. A broken or blocked store must not turn the card into a popup on every
 * reaction for the rest of the session.
 */
describe('seen reactions', () => {
  it('a reaction is new once, then remembered, and the library sees it', () => {
    const kv = memKV()
    expect([...seenReactions(kv)]).toEqual([])
    expect(markReactionSeen('nova', kv)).toBe(true)
    expect(markReactionSeen('nova', kv)).toBe(false)
    expect([...seenReactions(kv)]).toEqual(['nova'])
  })

  it('junk in storage is ignored; blocked storage still remembers the session', () => {
    const kv = memKV()
    kv.data['brawlock.wild.reactions'] = '["shatter","bogus",3]'
    expect(seenReactions(kv).has('shatter')).toBe(true)
    expect(seenReactions(kv).size).toBeGreaterThanOrEqual(1)
    const blocked: KV = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(markReactionSeen('fork', blocked)).toBe(true)
    expect(markReactionSeen('fork', blocked)).toBe(false)
  })
})
