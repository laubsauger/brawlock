/** The existing round-end pause gets one eased, full-body hero shot. */
export function victoryCameraWeight(age: number, secondsLeft: number): number {
  const ease = (v: number) => { const x = Math.max(0, Math.min(1, v)); return x * x * (3 - 2 * x) }
  return ease(age / 0.65) * ease(secondsLeft / 0.45)
}

export function victoryCameraOffset(facing: number, aspect: number) {
  // Preserve the whole raised-arm silhouette on narrow screens too.
  const distance = 760 * Math.max(1, 0.85 / aspect)
  const pitch = 32 * Math.PI / 180
  return { x: Math.cos(facing) * Math.cos(pitch) * distance, y: Math.sin(facing) * Math.cos(pitch) * distance, height: Math.sin(pitch) * distance, fov: 45 }
}
