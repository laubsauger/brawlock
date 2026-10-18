/** The existing round-end pause gets one eased, full-body hero shot. */
export function victoryCameraWeight(age: number, releaseAge: number | null = null): number {
  const ease = (v: number) => { const x = Math.max(0, Math.min(1, v)); return x * x * (3 - 2 * x) }
  // Hold through the round boundary. Returning before respawn would move toward
  // the old arena focus, then reverse again when the new round moves the player.
  return ease(age / 0.65) * (releaseAge === null ? 1 : 1 - ease(releaseAge / 0.75))
}

export function victoryCameraOffset(facing: number, aspect: number) {
  // Preserve the whole raised-arm silhouette on narrow screens too.
  const distance = 760 * Math.max(1, 0.85 / aspect)
  const pitch = 32 * Math.PI / 180
  return { x: Math.cos(facing) * Math.cos(pitch) * distance, y: Math.sin(facing) * Math.cos(pitch) * distance, height: Math.sin(pitch) * distance, fov: 45 }
}
