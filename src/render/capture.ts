/** One-shot renderer capture; no retained pixel buffers or per-frame work. */
const captures = new WeakMap<HTMLCanvasElement, () => HTMLCanvasElement>()

/** A mounted render loop owns capture until its pipeline or canvas is disposed. */
export function registerRenderCapture(canvas: HTMLCanvasElement, capture: () => HTMLCanvasElement): () => void {
  if (captures.has(canvas)) throw new Error('This canvas already has a render capture owner.')
  captures.set(canvas, capture)
  return () => {
    if (captures.get(canvas) === capture) captures.delete(canvas)
  }
}

export function canCaptureRenderCanvas(canvas: HTMLCanvasElement): boolean {
  return captures.has(canvas)
}

/** Copies the current scene synchronously, before a reporting dialog changes it. */
export function captureRenderCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const capture = captures.get(canvas)
  if (!capture) throw new Error('This canvas has no active render capture owner.')
  return capture()
}
