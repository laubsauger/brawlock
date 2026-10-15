import { useEffect, useState } from 'react'
import { toast } from './toast'

/**
 * Fullscreen API with the WebKit fallback (older Safari). The page itself goes
 * fullscreen; the render canvas follows through its own resize handling and
 * the HUD scale recomputes on resize. Alt+Enter toggles it (App): F11 belongs
 * to the browser and cannot be intercepted reliably.
 */
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void }
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

export function isFullscreen(): boolean {
  const d = document as FsDoc
  return !!(d.fullscreenElement || d.webkitFullscreenElement)
}

export function fullscreenSupported(): boolean {
  const el = document.documentElement as FsEl
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
}

export async function toggleFullscreen(): Promise<void> {
  const d = document as FsDoc
  const el = document.documentElement as FsEl
  try {
    if (isFullscreen()) {
      if (d.exitFullscreen) await d.exitFullscreen()
      else await d.webkitExitFullscreen?.()
    } else if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
    else toast('This browser cannot go fullscreen.')
  } catch {
    toast('The browser blocked fullscreen. Try again with a click or Alt+Enter.')
  }
}

/** React: current fullscreen state. */
export function useFullscreen(): boolean {
  const [on, setOn] = useState(() => (typeof document !== 'undefined' ? isFullscreen() : false))
  useEffect(() => {
    const sync = () => setOn(isFullscreen())
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])
  return on
}
