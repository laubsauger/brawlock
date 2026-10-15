import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { installCursors } from './ui/lib/cursors'
import { installStaleBuildRecovery } from './lib/staleBuild'

installCursors()
installStaleBuildRecovery()
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
