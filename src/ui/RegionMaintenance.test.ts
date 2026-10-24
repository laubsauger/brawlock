import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { RegionStatus } from '../net/online'
import { RegionMaintenance } from './RegionMaintenance'

const region = (id: string, draining: boolean): RegionStatus => ({ id, label: id.toUpperCase(), url: `wss://${id}`, state: 'up',
  rttMs: 30, samples: [], healthy: true, versionOk: true, players: 0, rooms: 0, at: 0,
  maintenance: draining ? { draining: true, message: null } : null })
const render = (statuses: RegionStatus[], selected?: RegionStatus | null) => renderToStaticMarkup(createElement(RegionMaintenance, { statuses, selected }))
const expectNotice = (html: string) => {
  expect(html.match(/role="status"/g)).toHaveLength(1)
  expect(html.replace(/<[^>]*>/g, '').trim()).not.toBe('')
}

it('renders one accessible notice when the whole fleet drains', () => {
  expectNotice(render([region('eu', true), region('us', true)]))
})

it('names affected regions in the all-regions browser notice', () => {
  const affected = region('affected-region', true)
  const healthy = region('healthy-region', false)
  const html = render([affected, healthy])
  expectNotice(html)
  expect(html).toContain(affected.label)
  expect(html).not.toContain(healthy.label)
})

it('identifies the selected region when its maintenance affects the player', () => {
  const eu = region('eu', true)
  const html = render([eu, region('us', false)], eu)
  expectNotice(html)
  expect(html).toContain(eu.label)
})

it('keeps unrelated maintenance out of a healthy selected region', () => {
  const us = region('us', false)
  expect(render([region('eu', true), us], us)).toBe('')
  expect(render([region('eu', true), us], null)).toBe('')
})

it('shows the whole-fleet notice even when Auto has no selected region', () => {
  expectNotice(render([region('eu', true), region('us', true)], null))
})

it('adds no notice when regions are open', () => {
  expect(render([region('eu', false)])).toBe('')
})
