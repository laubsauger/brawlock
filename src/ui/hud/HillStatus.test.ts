import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { frame, pushState, resetFrame } from '../../game/frame'
import { HILL_CAPTURE_SECONDS, HILL_TICKET_SECONDS, ticks } from '../../sim/config'
import { fight, place, pawn, run } from '../../sim/testkit'
import { HillStatus } from './HillStatus'

afterEach(resetFrame)
const render = () => renderToStaticMarkup(createElement(HillStatus))

describe('King of the Hill status plate', () => {
  it('stays away outside King of the Hill', () => {
    pushState(fight())
    expect(render()).toBe('')
  })

  it('says who holds the hill and shows the ticket race toward the target', () => {
    const s = fight(2, undefined, { gameMode: 'hill', winScore: 100 })
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 1000, 0)
    // two tickets: the capture time, then one ticket period more
    run(s, ticks(HILL_CAPTURE_SECONDS) + ticks(HILL_TICKET_SECONDS))
    frame.localPlayer = 0
    pushState(s)
    const html = render()
    expect(html).toContain('You hold')
    expect(html).toContain('data-status="held"')
    expect(html).toMatch(/2<span[^>]*>\/100/)
  })

  it('calls out a contested hill', () => {
    const s = fight(2, undefined, { gameMode: 'hill', winScore: 100 })
    place(pawn(s, 0), 0, 0)
    place(pawn(s, 1), 192, 0)
    run(s, 2)
    frame.localPlayer = 1
    pushState(s)
    expect(render()).toContain('Hill contested')
  })
})
