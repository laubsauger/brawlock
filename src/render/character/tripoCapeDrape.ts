import { BufferGeometry, Vector3 } from 'three/webgpu'

/** Guided fabric strips: spring lag, fixed fibre lengths, no folding topology. */
export class CapeDrape {
  readonly points: Vector3[]
  readonly rest: Vector3[]
  private readonly guide: Vector3[]
  private readonly velocity: Vector3[]
  private readonly safe: Vector3[]
  private readonly lengths: number[]
  private readonly offsets: number[]
  private readonly delta = new Vector3()
  private readonly temp = new Vector3()
  private readonly normal = new Vector3()
  private accumulator = 0
  lastSteps = 0

  constructor(readonly geometry: BufferGeometry, readonly columns: number) {
    const p = geometry.attributes.position, stride = columns + 1
    this.rest = Array.from({ length: p.count }, (_, i) => new Vector3().fromBufferAttribute(p, i))
    this.points = this.rest.map(p => p.clone())
    this.guide = this.rest.map(p => p.clone())
    this.safe = this.rest.map(p => p.clone())
    this.velocity = this.rest.map(() => new Vector3())
    this.lengths = this.rest.map((p, i) => i < stride ? 0 : p.distanceTo(this.rest[i - stride]))
    this.offsets = Array.from({ length: p.count / stride }, () => 0)
  }

  reset(targets: Vector3[]) {
    this.accumulator = 0; this.lastSteps = 0
    for (let i = 0; i < this.points.length; i++) {
      this.points[i].copy(targets[i]); this.guide[i].copy(targets[i]); this.velocity[i].set(0, 0, 0)
    }
    this.write()
  }

  update(dt: number, targets: Vector3[], goals: Vector3[], gravity: Vector3, wind: Vector3, contact: (point: Vector3, index: number) => void) {
    this.lastSteps = 0
    if (dt <= 0) return
    const step = 1 / 60, stride = this.columns + 1, rows = this.points.length / stride
    // A slow frame never starts an increasing physics catch-up workload.
    this.accumulator = Math.min(this.accumulator + dt, step * 2)
    const count = Math.floor((this.accumulator + 1e-10) / step)
    this.lastSteps = count
    if (!count) return
    this.accumulator -= count * step
    for (let i = 0; i < goals.length; i++) this.safe[i].copy(goals[i])

    // One coherent outward contact for each crosswise strip. Independent
    // projections of adjacent particles were fighting and knotting the sheet.
    for (let row = 1; row < rows; row++) {
      const start = row * stride, center = start + Math.floor(this.columns / 2)
      this.normal.crossVectors(this.delta.subVectors(goals[start + this.columns], goals[start]), this.temp.subVectors(goals[center], goals[center - stride])).normalize()
      let offset = 0
      for (let col = 0; col < stride; col++) {
        const i = start + col
        contact(this.safe[i], i)
        offset = Math.max(offset, this.delta.subVectors(this.safe[i], goals[i]).dot(this.normal))
      }
      this.offsets[row] = offset
    }
    for (let row = 1; row < rows; row++) {
      const start = row * stride, center = start + Math.floor(this.columns / 2), t = row / (rows - 1)
      this.normal.crossVectors(this.delta.subVectors(goals[start + this.columns], goals[start]), this.temp.subVectors(goals[center], goals[center - stride])).normalize()
      // Spread a contact over neighbouring strips instead of creating a hinge.
      let offset = this.offsets[row]
      for (let d = -2; d <= 2; d++) if (row + d > 0 && row + d < rows) offset = Math.max(offset, this.offsets[row + d] * (1 - Math.abs(d) * .3))
      for (let col = 0; col < stride; col++) this.safe[start + col].copy(goals[start + col]).addScaledVector(this.normal, offset).addScaledVector(wind, .015 * t * t)
    }

    for (let sub = 0; sub < count; sub++) for (let row = 0; row < rows; row++) {
      const t = row / (rows - 1), omega = 24 - 12 * t, decay = Math.exp(-omega * step)
      for (let col = 0; col < stride; col++) {
        const i = row * stride + col, p = this.guide[i], v = this.velocity[i]
        if (!row) { p.copy(targets[i]); v.set(0, 0, 0); continue }
        // Exact critically damped spring: stable without an iterative sheet solver.
        this.delta.subVectors(p, this.safe[i])
        this.temp.copy(v).addScaledVector(this.delta, omega)
        p.copy(this.safe[i]).addScaledVector(this.delta, decay).addScaledVector(this.temp, step * decay)
        v.addScaledVector(this.temp, -omega * step).multiplyScalar(decay)
        const limit = .015 + .06 * t * t
        this.delta.subVectors(p, this.safe[i])
        const distance = this.delta.length()
        if (distance > limit) { p.copy(this.safe[i]).addScaledVector(this.delta, limit / distance); v.multiplyScalar(.5) }
        // Follow contacts immediately inward; retain spring lag away from the body.
        this.normal.subVectors(this.safe[i], goals[i])
        const depth = this.normal.length()
        if (depth > 1e-8) {
          this.normal.multiplyScalar(1 / depth)
          const signed = this.delta.subVectors(p, this.safe[i]).dot(this.normal)
          if (signed < 0) p.addScaledVector(this.normal, -signed)
        }
      }
    }

    // Sample each moving curve by the original fabric's arc length. When a
    // knee or hip takes up fabric, the hem slides upward; it cannot stretch.
    for (let col = 0; col < stride; col++) {
      this.points[col].copy(targets[col])
      let segment = 1, consumed = 0, distance = 0
      for (let row = 1; row < rows; row++) {
        const i = row * stride + col
        distance += this.lengths[i]
        while (segment < rows - 1) {
          const length = this.guide[segment * stride + col].distanceTo(this.guide[(segment - 1) * stride + col])
          if (consumed + length >= distance) break
          consumed += length; segment++
        }
        const a = this.guide[(segment - 1) * stride + col], b = this.guide[segment * stride + col], length = a.distanceTo(b)
        if (length > 1e-8 && distance <= consumed + length) this.points[i].lerpVectors(a, b, (distance - consumed) / length)
        else this.points[i].copy(b).addScaledVector(this.temp.copy(gravity).normalize(), Math.max(0, distance - consumed - length))
      }
    }
    this.write()
  }

  private write() {
    const p = this.geometry.attributes.position
    for (let i = 0; i < this.points.length; i++) p.setXYZ(i, this.points[i].x, this.points[i].y, this.points[i].z)
    p.needsUpdate = true
    this.geometry.computeVertexNormals()
  }
}
