/** Tiny toast bus: short confirmations ("Q ⇄ W swapped") shown by <Toasts/> in App. */
type Listener = (text: string) => void
const listeners = new Set<Listener>()

export function toast(text: string): void {
  for (const l of listeners) l(text)
}

export function onToast(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
