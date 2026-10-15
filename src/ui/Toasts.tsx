import { useEffect, useState } from 'react'
import { onToast, type ToastTone } from './lib/toast'
import { WarnGlyph } from './hud/ConnIndicator'

/** Short confirmations under the top HUD strip (below the score pills); newest replaces the last. */
export function Toasts() {
  const [msg, setMsg] = useState<{ text: string; tone: ToastTone; key: number } | null>(null)
  useEffect(() => {
    let n = 0
    let timer = 0
    const off = onToast((text, tone) => {
      setMsg({ text, tone, key: ++n })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setMsg(null), tone === 'warn' ? 5000 : 3200)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [])
  if (!msg) return null
  return (
    <div className="pointer-events-none fixed top-[124px] right-0 left-0 z-[70] flex justify-center px-4" role="status" aria-live="polite">
      <div
        key={msg.key}
        className={`toast pop-in ink-sm flex max-w-xl items-center gap-2 rounded-md px-4 py-2 text-center text-[0.98rem] font-semibold ${msg.tone === 'warn' ? 'toast-warn text-[#ffd9c7]' : 'text-[#ffe6bf]'}`}
      >
        {msg.tone === 'warn' && <WarnGlyph />}
        {msg.text}
      </div>
    </div>
  )
}
