import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RegionStatus } from '../net/online'
import { RegionMaintenance } from './RegionMaintenance'

const region = (id: string, draining: boolean): RegionStatus => ({ id, label: id.toUpperCase(), url: `wss://${id}`, state: 'up',
  rttMs: 30, samples: [], healthy: true, versionOk: true, players: 0, rooms: 0, at: 0,
  maintenance: draining ? { draining: true, message: null } : null })
const render = (statuses: RegionStatus[]) => renderToStaticMarkup(createElement(RegionMaintenance, { statuses }))

it('shows an explicit new-games pause and reconnect explanation when the whole fleet drains', () => {
  const html = render([region('eu', true), region('us', true)])
  expect(html).toContain('Maintenance · EU · US')
  expect(html).toContain('New server games are paused')
  expect(html).toContain('Existing matches can finish')
  expect(html).toContain('use Rejoin')
  expect(html).not.toContain('Choose another region')
})

it('offers another region only when maintenance does not cover the whole fleet', () => {
  const html = render([region('eu', true), region('us', false)])
  expect(html).toContain('Maintenance · EU')
  expect(html).toContain('Choose another region')
  expect(html).not.toContain('Maintenance · EU · US')
})

it('adds no notice when regions are open', () => {
  expect(render([region('eu', false)])).toBe('')
})
