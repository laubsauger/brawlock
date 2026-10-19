import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error Operator tool is JavaScript, run directly by Node in production.
import { withGuestPlay } from '../../scripts/release/verify-fleet.mjs'

afterEach(() => vi.unstubAllGlobals())
const entry = { region: 'eu' }, opts = { origin: 'https://brawlock.osc.link' }
const token = 'a'.repeat(43)

function authority() {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string)
    requests.push({ url, headers: options.headers as Record<string, string>, body })
    return new Response(JSON.stringify(body.action === 'acquire' ? { ok: true, token } : { ok: true }), {
      headers: { 'set-cookie': 'brawlock.ranked_device=signed-browser; Path=/; HttpOnly; Secure' },
    })
  }))
  return requests
}

it('acquires and releases a guest permission with the same signed browser identity', async () => {
  const requests = authority()
  const run = vi.fn(async (permission: string) => { expect(permission).toBe(token); return 'joined-and-left' })
  expect(await withGuestPlay(entry, opts, run)).toBe('joined-and-left')
  expect(requests).toHaveLength(2)
  expect(requests[0].url).toBe(opts.origin + '/api/play')
  expect(requests[0].body).toMatchObject({ action: 'acquire', target: { mode: 'casual', region: 'eu', code: null } })
  expect(requests[0].headers.origin).toBe(opts.origin)
  expect(requests[1].body).toEqual({ device: requests[0].body.device, controller: requests[0].body.controller, action: 'release', token })
  expect(requests[1].headers.cookie).toBe('brawlock.ranked_device=signed-browser')
})

it('releases ownership when lobby admission fails', async () => {
  const requests = authority()
  await expect(withGuestPlay(entry, opts, async () => { throw new Error('lobby refused') })).rejects.toThrow('lobby refused')
  expect(requests[1].body.action).toBe('release')
})

it('fails before opening a lobby if authority rejects admission, without exposing its response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private authority response', { status: 409 })))
  const run = vi.fn()
  await expect(withGuestPlay(entry, opts, run)).rejects.toThrow('eu: guest game permission request failed')
  expect(run).not.toHaveBeenCalled()
})

it('does not report success when permission release is rejected', async () => {
  const requests = authority()
  const previous = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (...args: Parameters<typeof fetch>) => {
    if (requests.length) return new Response(JSON.stringify({ ok: false }))
    return previous(...args)
  }))
  await expect(withGuestPlay(entry, opts, async () => true)).rejects.toThrow('permission was not released')
})
