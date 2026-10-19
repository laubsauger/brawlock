import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('distinguishes document controllers even when another tab clones the reload-stable reconnect key', async () => {
  vi.stubGlobal('sessionStorage', { getItem: () => 'a-cloned-tab-reconnect-key', setItem: vi.fn() })
  const first = await import('./clientKey')
  const controller = first.controllerKey()
  expect(first.controllerKey()).toBe(controller)
  vi.resetModules()
  const second = await import('./clientKey')
  expect(second.clientKey()).toBe(first.clientKey())
  expect(second.controllerKey()).not.toBe(controller)
})
