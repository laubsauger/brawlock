import { describe, expect, it } from 'vitest'
import { ticks } from '../../sim/config'
import { deathNextStep, deathRecap, type DeathEvent } from './deathRecap'

const death: DeathEvent = { type: 'death', pawn: 1, owner: 0, killer: 2, cause: 'lightning' }

describe('local death feedback', () => {
  it('explains the authoritative lethal spell rather than assuming lava', () => {
    expect(deathRecap(death, 'Thorn')).toBe('Thorn · Lightning')
    expect(deathRecap({ ...death, cause: 'lava' }, 'Thorn')).toBe('Pushed into the lava by Thorn')
    expect(deathRecap({ ...death, cause: 'obstacle' }, 'Thorn')).toBe('Caught in Thorn’s pillar blast')
  })

  it('does not invent a killer or a lava cause for uncredited deaths', () => {
    expect(deathRecap({ ...death, cause: 'lava' }, null)).toBe('Consumed by the lava')
    expect(deathRecap({ ...death, cause: 'scourge' }, null)).toBe('Taken down by Scourge')
    expect(deathRecap({ ...death, cause: undefined }, null)).toBe('Knocked out')
  })

  it('shows the actual respawn countdown and switches to round flow when it ends', () => {
    // a tick past two seconds still counts as the third second
    expect(deathNextStep('deathmatch', 'fight', ticks(2) + 1)).toBe('Respawning in 3s')
    expect(deathNextStep('deathmatch', 'fight', 1)).toBe('Respawning in 1s')
    expect(deathNextStep('deathmatch', 'fight', 0)).toBe('Waiting to respawn')
    expect(deathNextStep('deathmatch', 'roundEnd', ticks(2) + 1)).toBe('Next round shortly')
    expect(deathNextStep('rounds', 'fight', 0)).toBe('Watching the rest of the round')
    // the hill respawns only in its respawn style, where a timer is running
    expect(deathNextStep('hill', 'fight', 1)).toBe('Respawning in 1s')
    expect(deathNextStep('hill', 'fight', 0)).toBe('Watching the rest of the round')
  })
})
