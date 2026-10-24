/**
 * Input redundancy over the unreliable channel.
 *
 * The client numbers every non-empty tick of commands (seq 1, 2, ...) and sends
 * ALL unacknowledged frames in every packet. The host applies frames strictly in
 * seq order, each exactly once, and acks the highest applied seq in snapshots.
 * A lost input packet is therefore covered by the next one, and a lost ack only
 * costs a few bytes of resend.
 * On a lossless link (WebSocket, or WebRTC on its reliable fallback) the session sends
 * each frame once (unsent) and resends everything unacked only when an ack is overdue.
 */
import type { InputCommand } from '../sim/types'
import type { InputFrame } from './protocol'

/** cap per packet; the oldest frames go first so the host never sees a gap */
export const MAX_FRAMES_PER_PACKET = 32

export class InputSender {
  private nextSeq = 1
  private pending: InputFrame[] = []
  /** highest seq handed to a packet so far */
  private sentSeq = 0

  /** Queue one tick of commands. Empty ticks are not sent. Returns the frame's seq, 0 if empty. */
  add(tick: number, cmds: InputCommand[]): number {
    if (cmds.length === 0) return 0
    const seq = this.nextSeq++
    this.pending.push({ seq, tick, cmds })
    return seq
  }

  /** Host applied everything up to `seq`. */
  ack(seq: number): void {
    let i = 0
    while (i < this.pending.length && this.pending[i].seq <= seq) i++
    if (i > 0) this.pending.splice(0, i)
  }

  /** Frames for the next packet: every unacked frame, oldest first. */
  frames(): InputFrame[] {
    const out = this.pending.length <= MAX_FRAMES_PER_PACKET ? this.pending : this.pending.slice(0, MAX_FRAMES_PER_PACKET)
    if (out.length) this.sentSeq = Math.max(this.sentSeq, out[out.length - 1].seq)
    return out
  }

  /** Frames never sent yet, oldest first (lossless links). */
  unsent(): InputFrame[] {
    const i = this.pending.findIndex((f) => f.seq > this.sentSeq)
    if (i < 0) return []
    const out = this.pending.slice(i, i + MAX_FRAMES_PER_PACKET)
    this.sentSeq = out[out.length - 1].seq
    return out
  }

  /** seq of the oldest unacked frame, 0 when everything is acked */
  get oldest(): number {
    return this.pending.length ? this.pending[0].seq : 0
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
