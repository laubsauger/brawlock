// Reproducible synthetic fixture for the private explorer; never opens game data.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openAnalytics } from '../server/analytics.mjs'
import { renderAnalytics } from './analytics-report.mjs'

const dir = mkdtempSync(join(tmpdir(), 'brawlock-demo-')), output = resolve('artifacts/analytics/demo')
const DAY = 86400000, end = Date.parse('2026-10-19T12:00:00Z')
let at = end - 180 * DAY
const open = (id, commit) => openAnalytics(join(dir, id + '.sqlite'), { now: () => at, serverCommit: commit })
const stores = { accounts: open('accounts'), eu: open('eu', 'demo-commit-a1'), 'us-west': open('us-west', 'demo-commit-a1') }
try {
  for (let d = 0; d < 180; d++) {
    at = end - (179 - d) * DAY
    if (d === 135) for (const region of ['eu', 'us-west']) { stores[region].close(); stores[region] = open(region, 'demo-commit-b2'); stores[region].recover() }
    const build = d < 135 ? 'demo-app-a1' : d < 165 ? 'demo-app-b2' : 'demo-app-c3', net = d < 135 ? 'demo-net-a1' : 'demo-net-b2'
    const sample = ['eu', 'us-west'].flatMap((region, r) => ['guest', 'account'].map((kind, k) => ({ region, build, net, screen: 'match', kind, people: 2 + r + k + Math.floor(d / 45) + Math.abs(Math.round(2 * Math.sin(d / 5))) })))
    const online = sample.reduce((n, row) => n + row.people, 0)
    for (let i = 0; i < 12 + Math.floor(d / 8) + Math.round(5 * Math.sin(d / 3)); i++) {
      const accountId = i % 3 === 0 || d > 135 && i % 7 === 0 ? 'demoaccount' + String(i).padStart(3, '0') : null
      const body = { device: 'demo_browser_' + i, accountId, region: (i + Math.floor(d / 3)) % 2 ? 'eu' : 'us-west',
        build: i % 13 ? build : '', net: i % 13 ? net : '', online, sample }
      for (const screen of i % 5 ? ['menu', 'lobby', 'match'] : ['menu', 'replay']) { stores.accounts.presence({ ...body, screen }); at += 30000 }
    }
    for (const region of ['eu', 'us-west']) for (let i = 0; i < 3 + Math.floor(d / 15) + Math.round(2 * Math.sin(d / 3)); i++) {
      const id = `demo-${d}-${region}-${i}`, queue = i % 3 === 0 ? 'ranked' : i % 3 === 1 ? 'casual' : 'custom'
      const devices = queue === 'ranked' ? ['a_demoaccount001', 'a_demoaccount002'] : ['demo_browser_1', 'a_demoaccount002']
      stores[region].start({ id, region, queue, build: i % 11 ? net : null, room: 'DEMOX', settings: { gameMode: queue === 'custom' ? 'deathmatch' : 'rounds', teamMode: i % 4 ? 'ffa' : 'teams' }, devices, bots: queue === 'ranked' ? 0 : 6 })
      if (i % 7 === 6) stores[region].abandon(id)
      else stores[region].finish(id, { ticks: (120 + i * 45 + (region === 'eu' ? 20 : 0)) * 60, rounds: 3 + i % 3, seats: devices.map((device) => ({ device })) })
    }
  }
  at = end + 2 * 3600000
  const reports = Object.entries(stores).map(([source, store]) => ({ source, ...store.report(90), ...(source === 'accounts' ? { accounts: { registered: 38, profiles: 34 }, live: { total: 10 } } : { live: { players: source === 'eu' ? 6 : 4, rooms: 2, connections: 7 } }) }))
  const snapshot = { demo: true, reports }
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'report.json'), JSON.stringify(snapshot))
  writeFileSync(join(output, 'index.html'), renderAnalytics(snapshot))
  console.log(join(output, 'index.html'))
} finally { for (const store of Object.values(stores)) store.close(); rmSync(dir, { recursive: true, force: true }) }
