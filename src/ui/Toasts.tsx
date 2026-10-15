import { useEffect, useState } from 'react'
import { onToast } from './lib/toast'

/** Short confirmations under the top HUD strip; newest replaces the last. */
export function Toasts() {
  const [msg, setMsg] = useState<{ text: string; key: number } | null>(null)
  useEffect(() => {
    let n = 0
    let timer = 0
    const off = onToast((text) => {
      setMsg({ text, key: ++n })
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setMsg(null), 3200)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [])
  if (!msg) return null
  return (
    <div className="pointer-events-none fixed top-[78px] right-0 left-0 z-[70] flex justify-center px-4" role="status" aria-live="polite">
      <div key={msg.key} className="toast pop-in ink-sm max-w-xl rounded-md px-4 py-2 text-center text-[0.98rem] font-semibold text-[#ffe6bf]">
        {msg.text}
      </div>
    </div>
  )
}
