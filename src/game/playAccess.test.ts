import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPlaySupported } from './playAccess'

afterEach(() => vi.unstubAllGlobals())

describe('desktop gameplay access', () => {
  it.each([
    [true, true, true],
    [false, false, false],
    [true, false, false],
    [false, true, false],
  ])('fine pointer=%s, hover=%s permits gameplay=%s', (fine, hover, allowed) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(any-pointer: fine)' ? fine : hover }))
    expect(isPlaySupported()).toBe(allowed)
  })
  it('does not assume input support where capabilities cannot be queried', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(isPlaySupported()).toBe(false)
  })
  it('allows a touchscreen computer when a fine pointing device is also available', () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 10 })
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect(isPlaySupported()).toBe(true)
  })
})
