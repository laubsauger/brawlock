/** Visual launch state: walking intent never cancels a body still flying. */
export class LaunchMotion {
  active = false
  age = 0
  private distance = 0

  start(): void {
    this.active = true
    this.age = 0
  }

  reset(): void {
    this.active = false
    this.age = this.distance = 0
  }

  step(speed: number, dt: number, mayStart: boolean): 'start' | 'recover' | null {
    if (speed < 240) {
      this.distance = 0
      if (this.active) {
        this.age += dt
        if (this.age >= 0.48) {
          this.active = false
          return 'recover'
        }
      }
      return null
    }
    this.distance += speed * dt
    if (this.active) {
      this.age += dt
      return null
    }
    // Ordinary Fireball-sized hits recoil. A true launch needs speed AND travel;
    // an extreme impulse can knock the feet out immediately.
    if (mayStart && speed >= 950 && (this.distance >= 70 || speed >= 1500)) {
      this.start()
      return 'start'
    }
    return null
  }
}

/** A death can gain an authoritative cause without restarting its fall. */
/** State snapshots can skip the shop event; round number still proves a new life. */
export class RoundEpoch {
  private round = -1

  advance(round: number): boolean {
    const changed = this.round >= 0 && round > this.round
    this.round = Math.max(this.round, round)
    return changed
  }
}

export class DeathMotion {
  active = false
  confirmed = false
  elapsed = 0
  private epoch = new RoundEpoch()

  beginRound(round: number): boolean {
    if (!this.epoch.advance(round)) return false
    this.reset()
    return true
  }

  begin(confirmed: boolean): boolean {
    this.confirmed ||= confirmed
    if (this.active) return false
    this.active = true
    this.elapsed = 0
    return true
  }

  advance(dt: number): number {
    return (this.elapsed += dt)
  }

  reset(): void {
    this.active = this.confirmed = false
    this.elapsed = 0
  }
}

/** One throw arc, a small landing rebound, then rest. Never starts another fall. */
export function deathHop(t: number): number {
  if (t <= 0) return 0
  if (t < 0.48) return 0.38 * Math.sin(Math.PI * t / 0.48)
  if (t < 0.68) return 0.055 * Math.sin(Math.PI * (t - 0.48) / 0.2)
  return 0
}
