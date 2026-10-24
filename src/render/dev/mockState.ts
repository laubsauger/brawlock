/**
 * Dev-only fake match so the scene can be built without the sim: two
 * warlocks walk, exchange fireballs, scourge and teleport, take lava damage,
 * die, and the arena shrinks on a short timer. NOT the real rules: numbers
 * are close enough to look right (speeds, radii, cast points, kb scale).
 */
import { DT, type PawnState, type PlayerSlot, type ProjectileState, type SimEvent, type SimState } from '../../sim/types'
import { ticks } from '../../sim/config'
import { isLocationSafe, layerRadius } from '../arenaGeom'

const SHOP_TICKS = ticks(2.5)
const SHRINK_TICKS = ticks(5)
const MIN_LAYER = 7
const FIGHT_LAYER = 15
const FRICTION = Math.pow(0.96, DT / 0.035)

interface MockOpts {
  /** menu backdrop: slower pace, no deaths */
  calm?: boolean
}

export interface MockMatch {
  step(): { state: SimState; events: SimEvent[] }
}

function makePawn(id: number, owner: number, x: number, y: number): PawnState {
  return {
    id,
    owner,
    x,
    y,
    vx: 0,
    vy: 0,
    walkVx: 0,
    walkVy: 0,
    facing: 0,
    hp: 1000,
    maxHp: 1000,
    hpRegen: 5,
    moveSpeed: 210,
    kbPoints: 0,
    kbFactor: 1,
    alive: true,
    invulnerable: false,
    moveTarget: null,
    cast: null,
    cooldowns: [0, 0, 0],
    slots: ['fireball', 'scourge', 'teleport'],
    levels: [1, 1, 1],
    modifiers: [],
    lastHitter: null,
    lavaTicks: 0,
  }
}

export function createMockMatch(opts: MockOpts = {}): MockMatch {
  const calm = !!opts.calm
  const slots: PlayerSlot[] = [
    { id: 0, name: 'Emberveil', color: 0xff5a36, team: 0, kind: 'human' },
    { id: 1, name: 'Frostbinder', color: 0x3fa9ff, team: 1, kind: 'bot', difficulty: 'medium' },
  ]
  let tick = 0
  let nextId = 10
  let phase: SimState['phase'] = 'shop'
  let phaseLeft = SHOP_TICKS
  let round = 1
  let layer = 14
  let nextShrink = -1
  let theme = 0
  let pawns: PawnState[] = []
  let projectiles: ProjectileState[] = []
  let lavaAcc = 0

  const spawnPawns = () => {
    pawns = [makePawn(1, 0, -700, 80), makePawn(2, 1, 700, -80)]
    pawns[0].facing = 0
    pawns[1].facing = Math.PI
  }
  spawnPawns()

  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  const other = (p: PawnState) => pawns.find((q) => q !== p && q.alive)

  const step = (): { state: SimState; events: SimEvent[] } => {
    tick++
    const events: SimEvent[] = []

    // ---- phases and arena
    phaseLeft--
    if (phase === 'shop' && phaseLeft <= 0) {
      phase = 'fight'
      layer = FIGHT_LAYER
      nextShrink = tick + SHRINK_TICKS
      events.push({ type: 'phase', phase: 'fight', round })
      phaseLeft = -1
    } else if (phase === 'fight') {
      if (nextShrink > 0 && tick >= nextShrink) {
        layer--
        events.push({ type: 'arenaShrink', layer })
        nextShrink = layer > MIN_LAYER ? tick + SHRINK_TICKS : -1
      }
      const alive = pawns.filter((p) => p.alive)
      if (alive.length <= 1 || (nextShrink < 0 && layer <= MIN_LAYER && tick % ticks(10) === 0)) {
        phase = 'roundEnd'
        phaseLeft = 150
        if (alive.length === 1) events.push({ type: 'roundWin', team: slots[alive[0].owner].team, players: [alive[0].owner] })
        events.push({ type: 'phase', phase: 'roundEnd', round })
      }
    } else if (phase === 'roundEnd' && phaseLeft <= 0) {
      round++
      phase = 'shop'
      phaseLeft = SHOP_TICKS
      layer = 14
      nextShrink = -1
      theme = (theme + 1) % 3
      projectiles = []
      spawnPawns()
      events.push({ type: 'phase', phase: 'shop', round })
    }

    // ---- pawn AI and motion
    for (const p of pawns) {
      if (!p.alive) continue
      const foe = other(p)
      for (let i = 0; i < p.cooldowns.length; i++) p.cooldowns[i] = Math.max(0, p.cooldowns[i] - 1)

      // casting
      if (p.cast) {
        p.cast.ticksLeft--
        if (foe) p.facing = Math.atan2(p.cast.y - p.y, p.cast.x - p.x)
        if (p.cast.ticksLeft <= 0) {
          const c = p.cast
          p.cast = null
          events.push({ type: 'cast', pawn: p.id, spell: c.spell, x: c.x, y: c.y })
          if (c.spell === 'fireball') {
            const a = Math.atan2(c.y - p.y, c.x - p.x)
            const pr: ProjectileState = {
              id: nextId++,
              owner: p.owner,
              spell: 'fireball',
              x: p.x + Math.cos(a) * 45,
              y: p.y + Math.sin(a) * 45,
              vx: Math.cos(a) * 1000,
              vy: Math.sin(a) * 1000,
              radius: 25,
              ticksLeft: 60,
              data: {},
            }
            projectiles.push(pr)
            events.push({ type: 'projectileSpawn', id: pr.id, spell: 'fireball' })
          } else if (c.spell === 'scourge') {
            events.push({ type: 'explosion', x: p.x, y: p.y, radius: 250, spell: 'scourge' })
            p.hp = Math.max(1, p.hp - 100)
            for (const q of pawns) {
              if (q === p || !q.alive) continue
              const dx = q.x - p.x
              const dy = q.y - p.y
              const d = Math.hypot(dx, dy)
              if (d < 250 + 30) {
                const kb = 900 * (1 - (d / 250) * 0.25) * (1 + q.kbPoints / 1000)
                hitPawn(q, dx / (d || 1), dy / (d || 1), 100, kb, p.owner, events)
              }
            }
          }
        }
        continue
      }

      // decide
      const roll = Math.random()
      if (phase === 'fight' && foe) {
        const d = Math.hypot(foe.x - p.x, foe.y - p.y)
        if (p.cooldowns[0] === 0 && d < 1100 && roll < (calm ? 0.02 : 0.05)) {
          const lead = d / 1000
          const tx = foe.x + foe.vx * lead * 0.7
          const ty = foe.y + foe.vy * lead * 0.7
          p.cast = { slot: 0, spell: 'fireball', ticksLeft: 12, x: tx, y: ty }
          p.cooldowns[0] = calm ? 160 : 100
          events.push({ type: 'castStart', pawn: p.id, spell: 'fireball', ticks: 12 })
          p.walkVx = p.walkVy = 0
          continue
        }
        if (p.cooldowns[1] === 0 && d < 300 && roll < 0.08) {
          p.cast = { slot: 1, spell: 'scourge', ticksLeft: 54, x: p.x, y: p.y }
          p.cooldowns[1] = 240
          events.push({ type: 'castStart', pawn: p.id, spell: 'scourge', ticks: 54 })
          p.walkVx = p.walkVy = 0
          continue
        }
        const onLava = !isLocationSafe(p.x, p.y, layer)
        if (p.cooldowns[2] === 0 && (onLava || roll < 0.004)) {
          const R = layerRadius(layer) * 0.5
          const a = rnd(0, Math.PI * 2)
          const tx = Math.cos(a) * R * Math.random()
          const ty = Math.sin(a) * R * Math.random()
          events.push({ type: 'teleport', pawn: p.id, fromX: p.x, fromY: p.y, toX: tx, toY: ty })
          p.x = tx
          p.y = ty
          p.vx *= 0.8
          p.vy *= 0.8
          p.cooldowns[2] = 600
        }
      }
      if (!p.moveTarget || Math.hypot(p.moveTarget.x - p.x, p.moveTarget.y - p.y) < 30 || roll > 0.995) {
        const R = Math.max(150, layerRadius(layer) * 0.65)
        const a = rnd(0, Math.PI * 2)
        const rr = Math.sqrt(Math.random()) * R
        p.moveTarget = { x: Math.cos(a) * rr, y: Math.sin(a) * rr }
      }
      const dx = p.moveTarget.x - p.x
      const dy = p.moveTarget.y - p.y
      const d = Math.hypot(dx, dy) || 1
      const speed = calm ? 150 : p.moveSpeed
      p.walkVx = (dx / d) * speed
      p.walkVy = (dy / d) * speed
      const want = Math.atan2(dy, dx)
      let da = want - p.facing
      while (da > Math.PI) da -= Math.PI * 2
      while (da < -Math.PI) da += Math.PI * 2
      p.facing += Math.max(-0.2, Math.min(0.2, da))
    }

    // integrate: physics velocity decays, walk is added on top
    for (const p of pawns) {
      if (!p.alive) continue
      const kx = (p.vx - p.walkVx) * FRICTION
      const ky = (p.vy - p.walkVy) * FRICTION
      const walking = !p.cast
      p.vx = kx + (walking ? p.walkVx : 0)
      p.vy = ky + (walking ? p.walkVy : 0)
      if (!walking) {
        p.walkVx = 0
        p.walkVy = 0
      }
      p.x += p.vx * DT
      p.y += p.vy * DT
      p.hp = Math.min(p.maxHp, p.hp + p.hpRegen * DT)
    }

    // projectiles
    const keep: ProjectileState[] = []
    for (const pr of projectiles) {
      pr.x += pr.vx * DT
      pr.y += pr.vy * DT
      pr.ticksLeft--
      let gone = false
      for (const q of pawns) {
        if (!q.alive || q.owner === pr.owner) continue
        const dx = q.x - pr.x
        const dy = q.y - pr.y
        if (dx * dx + dy * dy < 55 * 55) {
          const sp = Math.hypot(pr.vx, pr.vy) || 1
          events.push({ type: 'projectileHit', id: pr.id, spell: pr.spell, x: pr.x, y: pr.y, target: q.id })
          const kb = 750 * (1 + q.kbPoints / 1000)
          hitPawn(q, pr.vx / sp, pr.vy / sp, 70, kb, pr.owner, events)
          gone = true
          break
        }
      }
      if (!gone && pr.ticksLeft <= 0) {
        events.push({ type: 'projectileExpire', id: pr.id, spell: pr.spell, x: pr.x, y: pr.y })
        gone = true
      }
      if (!gone) keep.push(pr)
    }
    projectiles = keep

    // lava
    lavaAcc++
    for (const p of pawns) {
      const safe = isLocationSafe(p.x, p.y, layer)
      p.lavaTicks = safe ? 0 : p.lavaTicks + 1
      if (!p.alive || safe || phase !== 'fight') continue
      if (lavaAcc % 15 === 0) {
        p.hp -= 25
        p.kbPoints += 12.5
        events.push({ type: 'damage', target: p.id, amount: 25, source: null, x: p.x, y: p.y, kb: 0 })
      }
    }
    for (const p of pawns) {
      if (p.alive && p.hp <= 0) {
        if (calm) {
          p.hp = p.maxHp
          continue
        }
        p.alive = false
        p.vx = p.vy = p.walkVx = p.walkVy = 0
        p.cast = null
        events.push({ type: 'death', pawn: p.id, owner: p.owner, killer: p.lastHitter })
      }
    }

    const state: SimState = {
      tick,
      rng: 1,
      nextEntityId: nextId,
      settings: {
        teamMode: 'ffa',
        gameMode: 'rounds',
        winScore: 11,
        startGold: 30,
        roundGold: 10,
        killGold: 0,
        winGold: 0,
        lavaDps: 100,
        kbMultiplier: 1,
        dmgMultiplier: 1,
        friction: 0.96,
        shopSeconds: 30,
        botsReplaceLeavers: true,
        spectatorBets: true,
        bounties: true,
      },
      slots,
      phase,
      phaseTicksLeft: phaseLeft,
      round,
      arena: { layer, nextShrinkTick: nextShrink, theme },
      scores: [],
      betting: { bets: [], bounties: [], credits: [], lastSettlement: null },
      // fresh objects every tick: the frame buffer contract forbids mutation after push
      pawns: pawns.map((p) => ({ ...p, cast: p.cast ? { ...p.cast } : null, moveTarget: p.moveTarget ? { ...p.moveTarget } : null })),
      projectiles: projectiles.map((p) => ({ ...p })),
      obstacles: [],
      events,
    }
    return { state, events }
  }

  function hitPawn(q: PawnState, nx: number, ny: number, dmg: number, kb: number, source: number, events: SimEvent[]): void {
    q.hp -= dmg
    q.kbPoints += dmg
    q.vx += nx * kb
    q.vy += ny * kb
    q.lastHitter = source
    events.push({ type: 'damage', target: q.id, amount: dmg, source, x: q.x, y: q.y, kb })
  }

  return { step }
}
