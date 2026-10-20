import { installAnalytics } from './lib/analytics'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { installErrorCapture } from './render/errorCapture'

installErrorCapture()
import { installCursors } from './ui/lib/cursors'
import { isTypingTarget } from './ui/lib/keys'
import { installStaleBuildRecovery } from './lib/staleBuild'

installCursors()
installStaleBuildRecovery()
installAnalytics()
// a game, not a page: right-click moves and never opens the browser menu, on any
// screen or overlay; text fields and links keep theirs (copy/paste, open in new tab)
window.addEventListener('contextmenu', (e) => {
  if (!isTypingTarget(e.target) && !(e.target instanceof Element && e.target.closest('a[href]'))) e.preventDefault()
})
// fetch the PeerJS chunk while this build's files still exist on the server,
// so joining after a later deploy never requests a deleted chunk
const warmPeer = () => void import('./net/peer').then((m) => m.loadPeer()).catch(() => {})
if ('requestIdleCallback' in window) requestIdleCallback(warmPeer, { timeout: 4000 })
else setTimeout(warmPeer, 2000)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
