import { describe, expect, it } from 'vitest'
import { FIREBALL_SLOT, isLocationSafe, type InputCommand } from '../sim'
import { PracticeScenario, TELEPORT_SLOT, type PracticeStep } from './practiceScenario'

const create = () => new PracticeScenario({ name: 'Learner', color: 0xff7700 })
function until(lesson: PracticeScenario, phase: PracticeStep, max = 1800) {
  for (let i = 0; i < max && lesson.view.step !== phase; i++) lesson.tick([])
  expect(lesson.view.step).toBe(phase)
}
function command(lesson: PracticeScenario, cmd: InputCommand) { lesson.tick([cmd]) }
function learnToHit(lesson: PracticeScenario) {
  command(lesson, { kind: 'move', x: -300, y: 180 })
  until(lesson, 'fireball')
  const dummy = lesson.state.pawns.find((p) => p.owner === 1)!
  command(lesson, { kind: 'cast', slot: FIREBALL_SLOT, x: dummy.x, y: dummy.y })
  until(lesson, 'shop')
}

describe('hands-on practice with the real simulation', () => {
  it('requires movement, a real hit, a paid Teleport purchase, a landing and a real lava knockout', () => {
    const lesson = create()
    const startingGold = lesson.state.scores[0].gold
    for (let i = 0; i < 120; i++) lesson.tick([])
    expect(lesson.view.step).toBe('move')
    learnToHit(lesson)
    expect(lesson.state.phase).toBe('shop')
    expect(lesson.state.pawns[0].slots[TELEPORT_SLOT]).toBeNull()
    command(lesson, { kind: 'buySpell', spell: 'lightning' })
    expect(lesson.state.scores[0].gold).toBe(startingGold)
    command(lesson, { kind: 'buySpell', spell: 'teleport' })
    expect(lesson.view.step).toBe('teleport')
    expect(lesson.state.scores[0].gold).toBe(0)
    expect(lesson.state.pawns[0].slots[TELEPORT_SLOT]).toBe('teleport')
    command(lesson, { kind: 'cast', slot: TELEPORT_SLOT, x: -300, y: 0 })
    expect(lesson.view.step).toBe('teleport') // Casting without reaching the target does not complete it.
    for (let i = 0; i < 121; i++) lesson.tick([])
    command(lesson, { kind: 'cast', slot: TELEPORT_SLOT, x: -120, y: 320 })
    expect(lesson.view.step).toBe('lava')
    expect(isLocationSafe(lesson.state, lesson.state.pawns[1].x, lesson.state.pawns[1].y)).toBe(true)
    command(lesson, { kind: 'cast', slot: FIREBALL_SLOT, x: 900, y: 0 })
    until(lesson, 'complete')
    expect(lesson.state.pawns[1].alive).toBe(false)
    expect(lesson.state.events).toContainEqual(expect.objectContaining({ type: 'death', owner: 1, killer: 0, cause: 'lava' }))
    for (let i = 0; i < 600; i++) lesson.tick([])
    expect(lesson.view.step).toBe('complete')
    expect(lesson.state.phase).toBe('shop')
    expect(lesson.state.settings).toMatchObject({ spectatorBets: false, bounties: false, roundGold: 0, killGold: 0, winGold: 0 })
  })

  it('does not mark a missed Fireball or merely pressing cast as a hit', () => {
    const lesson = create()
    command(lesson, { kind: 'move', x: -300, y: 180 })
    until(lesson, 'fireball')
    command(lesson, { kind: 'cast', slot: FIREBALL_SLOT, x: -900, y: 180 })
    for (let i = 0; i < 240; i++) lesson.tick([])
    expect(lesson.view.step).toBe('fireball')
  })

  it('keeps the shop untimed and restores a learner who falls in lava without losing the step', () => {
    const lesson = create()
    command(lesson, { kind: 'move', x: -300, y: 180 })
    until(lesson, 'fireball')
    command(lesson, { kind: 'move', x: -1500, y: 0 })
    for (let i = 0; i < 1500; i++) lesson.tick([])
    expect(lesson.view.step).toBe('fireball')
    expect(lesson.view.retries).toBe(1)
    expect(lesson.state.pawns[0].alive).toBe(true)
    expect(lesson.state.phase).toBe('fight')
    const dummy = lesson.state.pawns[1]
    command(lesson, { kind: 'cast', slot: FIREBALL_SLOT, x: dummy.x, y: dummy.y })
    until(lesson, 'shop')
    for (let i = 0; i < 1800; i++) lesson.tick([])
    expect(lesson.state.phase).toBe('shop')
    expect(lesson.view.step).toBe('shop')
  })
})
