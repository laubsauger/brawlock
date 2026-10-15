/** Tiny toast bus: short confirmations ("Q ⇄ W swapped") shown by <Toasts/> in App. */
export type ToastTone = 'info' | 'warn'
type Listener = (text: string, tone: ToastTone) => void
const listeners = new Set<Listener>()

export function toast(text: string, tone: ToastTone = 'info'): void {
  for (const l of listeners) l(text, tone)
}

export function onToast(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
