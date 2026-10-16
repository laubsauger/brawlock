/**
 * Fixed-capacity pool of live effect records (bolts, arcs, ghosts, ...), allocated once.
 *
 * `items[0 .. n)` are the live records. sweep() compacts by SWAPPING, so every slot always
 * holds a distinct object. Compacting by assignment (`items[w++] = r`) leaves stale duplicate
 * references in the tail; the next acquire() then hands out an object that is still live and
 * the new effect silently overwrites it (the Lightning miss bolt vanished this way when its
 * fray arcs were added right after it).
 */
export class LivePool<T> {
  readonly items: T[] = []
  n = 0

  constructor(
    capacity: number,
    make: () => T,
    /** true when a is older than b (the record replaced when the pool is full) */
    private readonly older: (a: T, b: T) => boolean,
  ) {
    for (let i = 0; i < capacity; i++) this.items.push(make())
  }

  /** a free record, or the oldest live one when full; the caller overwrites all its fields */
  acquire(): T {
    if (this.n < this.items.length) return this.items[this.n++]
    let o = this.items[0]
    for (let i = 1; i < this.n; i++) if (this.older(this.items[i], o)) o = this.items[i]
    return o
  }

  /** keep the records for which keep() is true (calls it once per live record, in order) */
  sweep(keep: (r: T) => boolean): void {
    let w = 0
    for (let i = 0; i < this.n; i++) {
      const r = this.items[i]
      if (!keep(r)) continue
      if (w !== i) {
        this.items[i] = this.items[w]
        this.items[w] = r
      }
      w++
    }
    this.n = w
  }

  clear(): void {
    this.n = 0
  }
}
