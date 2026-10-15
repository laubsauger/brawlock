/**
 * Input redundancy over the unreliable channel.
 *
 * The client numbers every non-empty tick of commands (seq 1, 2, ...) and sends
 * ALL unacknowledged frames in every packet. The host applies frames strictly in
 * seq order, each exactly once, and acks the highest applied seq in snapshots.
 * A lost input packet is therefore covered by the next one, and a lost ack only
 * costs a few bytes of resend.
 */
import type { InputCommand } from '../sim/types'
import type { InputFrame } from './protocol'

/** cap per packet; the oldest frames go first so the host never sees a gap */
export const MAX_FRAMES_PER_PACKET = 32

export class InputSender {
  private nextSeq = 1
  private pending: InputFrame[] = []

  /** Queue one tick of commands. Empty ticks are not sent. */
  add(tick: number, cmds: InputCommand[]): void {
    if (cmds.length === 0) return
    this.pending.push({ seq: this.nextSeq++, tick, cmds })
  }

  /** Host applied everything up to `seq`. */
  ack(seq: number): void {
    let i = 0
    while (i < this.pending.length && this.pending[i].seq <= seq) i++
    if (i > 0) this.pending.splice(0, i)
  }

  /** Frames for the next packet: every unacked frame, oldest first. */
  frames(): InputFrame[] {
    return this.pending.length <= MAX_FRAMES_PER_PACKET ? this.pending : this.pending.slice(0, MAX_FRAMES_PER_PACKET)
  }

  get unacked(): number {
    return this.pending.length
  }
}

export class InputReceiver {
  /** highest seq applied; also the ack value */
  lastSeq = 0

  /**
   * Returns the frames not seen before, in seq order. Duplicates and frames
   * beyond a gap are ignored (the sender resends everything unacked, so a gap
   * closes on a later packet).
   */
  accept(frames: InputFrame[]): InputFrame[] {
    const fresh: InputFrame[] = []
    for (const f of frames) {
      if (f.seq === this.lastSeq + 1) {
        fresh.push(f)
        this.lastSeq = f.seq
      }
    }
    return fresh
  }
}
