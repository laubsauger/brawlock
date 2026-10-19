import { describe, expect, it } from 'vitest'
import { consumeAccountReturn, prepareAccountReturn } from './accountReturn'

const nonce = 'a'.repeat(32)
const at = 1_000_000
function storage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}

describe('full-page account return continuation', () => {
  it('resumes the exact ranked region once, without storing an account or session credential', () => {
    const store = storage()
    const callback = prepareAccountReturn('https://brawlock.osc.link/?account=ranked&region=eu', store, at, nonce)
    expect(consumeAccountReturn(callback, store, at + 1000)).toEqual({ intent: 'ranked', region: 'eu', settings: false, problem: null })
    expect(consumeAccountReturn(callback, store, at + 1001)).toBeNull()
  })

  it('never trusts bare flags, another origin/path, changed intent/region, wrong nonce or an expired marker', () => {
    expect(consumeAccountReturn('https://brawlock.osc.link/?account=ranked&region=eu', storage(), at)).toBeNull()
    for (const mutate of [
      (u: URL) => { u.host = 'another.example' }, (u: URL) => { u.pathname = '/another' },
      (u: URL) => { u.searchParams.set('region', 'us-west') }, (u: URL) => { u.searchParams.set('account', 'open') },
      (u: URL) => { u.searchParams.set('accountReturn', 'b'.repeat(32)) },
    ]) {
      const store = storage(), callback = prepareAccountReturn('https://brawlock.osc.link/?account=ranked&region=eu', store, at, nonce)
      const changed = new URL(callback); mutate(changed)
      expect(consumeAccountReturn(changed.href, store, at + 1000)).toBeNull()
      expect(consumeAccountReturn(callback, store, at + 1001)).toBeNull()
    }
    const store = storage(), callback = prepareAccountReturn('https://brawlock.osc.link/?account=open', store, at, nonce)
    expect(consumeAccountReturn(callback, store, at + 16 * 60_000)).toBeNull()
  })

  it('keeps settings returns distinct and replaces provider errors with a private generic message', () => {
    const store = storage(), callback = prepareAccountReturn('https://brawlock.osc.link/?account=open', store, at, nonce, true)
    const url = new URL(callback); url.searchParams.set('error', 'provider response with private details')
    const result = consumeAccountReturn(url.href, store, at + 1)
    expect(result).toMatchObject({ intent: 'open', settings: true, problem: 'Sign-in was cancelled or could not be completed. Please try again.' })
    expect(JSON.stringify(result)).not.toContain('private details')
  })

  it('fails before navigating if tab storage cannot retain the continuation', () => {
    const store = storage(); store.setItem = () => { throw new Error('Tab storage unavailable.') }
    expect(() => prepareAccountReturn('https://brawlock.osc.link/?account=open', store, at, nonce)).toThrow('Tab storage unavailable.')
  })
})
