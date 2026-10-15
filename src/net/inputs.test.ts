import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputCommand } from '../sim/types'
import { InputReceiver, InputSender } from './inputs'
import { createMemoryPair } from './memory'
import { decode, encode, sanitizeFrames } from './protocol'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('input redundancy', () => {
  /**
   * Why: a dropped move or cast would make the game feel broken under loss, and a
   * duplicated cast would fire a spell twice. The host must apply every command
   * exactly once, in issue order, even with 30 % loss on BOTH directions (acks ride
   * lossy snapshots too).
   */
  it('applies every command exactly once and in order under 30% loss each way', async () => {
    const [client, host] = createMemoryPair({ latencyMs: 40, jitterMs: 25, loss: 0.3, seed: 7 })
    const sender = new InputSender()
    const receiver = new InputReceiver()
    const applied: InputCommand[] = []

    host.onMessage((d) => {
      const m = decode(d)
      if (m?.t !== 'input') return
      for (const f of receiver.accept(sanitizeFrames(m.inputs))) applied.push(...f.cmds)
    })
    client.onMessage((d) => {
      const m = decode(d)
      if (m?.t === 'snap') sender.ack(m.ack)
    })
    // let the raw channel prove itself so traffic really goes through the lossy path
    await vi.advanceTimersByTimeAsync(500)
    expect(client.unreliableMode).toBe('raw')

    const issued: InputCommand[] = []
    const TICKS = 600
    for (let tick = 0; tick < TICKS + 120; tick++) {
      // client tick: bursts of 0..3 commands, then a quiet tail so resends can finish
      if (tick < TICKS && tick % 3 === 0) {
        const cmds: InputCommand[] = []
        for (let i = 0; i < (tick / 3) % 4; i++) cmds.push({ kind: 'move', x: tick, y: i })
        issued.push(...cmds)
        sender.add(tick, cmds)
      }
      if (sender.unacked) client.sendUnreliable(encode({ t: 'input', match: 1, inputs: sender.frames() }))
      // host tick: ack in a (lossy) snapshot
      host.sendUnreliable(
        `{"t":"snap","match":1,"n":${tick},"iv":1,"ack":${receiver.lastSeq},"ev":[],"state":{}}`,
      )
      await vi.advanceTimersByTimeAsync(1000 / 60)
    }

    expect(client.sent.dropped).toBeGreaterThan(client.sent.unreliable * 0.2) // loss really happened
    expect(host.sent.dropped).toBeGreaterThan(0)
    expect(applied).toEqual(issued)
    expect(sender.unacked).toBe(0)
  })

  it('ignores duplicates and frames past a gap', () => {
    const r = new InputReceiver()
    const f = (seq: number) => ({ seq, tick: 0, cmds: [{ kind: 'stop' } as InputCommand] })
    expect(r.accept([f(1), f(2)]).map((x) => x.seq)).toEqual([1, 2])
    expect(r.accept([f(1), f(2)])).toEqual([])
    expect(r.accept([f(4)])).toEqual([])
    expect(r.accept([f(3), f(4)]).map((x) => x.seq)).toEqual([3, 4])
  })
})
