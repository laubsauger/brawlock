/**
 * Micro-animation helpers for JS-driven motion (count-ups, pulses). CSS
 * animations already collapse under prefers-reduced-motion (index.css); these
 * check the same preference for Web Animations and rAF tweens.
 */
export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** A short scale-and-glow pop on an element (value changed, level gained). */
export function pop(el: Element | null, scale = 1.25, ms = 420): void {
  if (!el || reducedMotion() || !('animate' in el)) return
  ;(el as HTMLElement).animate(
    [
      { transform: `scale(${scale})`, filter: 'brightness(1.6)' },
      { transform: 'scale(1)', filter: 'brightness(1)' },
    ],
    { duration: ms, easing: 'cubic-bezier(.2,1.4,.4,1)' },
  )
}

/** Brief bright flash (damage taken, purchase confirmed). */
export function flashEl(el: Element | null, ms = 220): void {
  if (!el || reducedMotion() || !('animate' in el)) return
  ;(el as HTMLElement).animate([{ filter: 'brightness(1.9) saturate(1.3)' }, { filter: 'none' }], { duration: ms, easing: 'ease-out' })
}

/**
 * Tween a number from `from` to `to` over `ms`, calling `write` each frame with
 * the rounded value. Returns a cancel function. Instant under reduced motion.
 */
export function countTo(from: number, to: number, ms: number, write: (v: number) => void, delay = 0): () => void {
  if (reducedMotion() || from === to) {
    write(to)
    return () => {}
  }
  let raf = 0
  let start = 0
  const step = (now: number) => {
    if (!start) start = now + delay
    const f = Math.max(0, Math.min(1, (now - start) / ms))
    const eased = 1 - Math.pow(1 - f, 3)
    write(Math.round(from + (to - from) * eased))
    if (f < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return () => cancelAnimationFrame(raf)
}

/**
 * Children of `ref` rise in one after another on mount (Web Animations, so it
 * composes with any CSS animation already on them, e.g. the primary button glow).
 */
export function staggerIn(el: HTMLElement | null, step = 55, delay = 90): void {
  if (!el || reducedMotion()) return
  Array.from(el.children).forEach((child, i) => {
    ;(child as HTMLElement).animate(
      [
        { opacity: 0, transform: 'translateY(12px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 460, delay: delay + i * step, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'backwards' },
    )
  })
}
