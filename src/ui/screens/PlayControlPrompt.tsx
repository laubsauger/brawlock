import { useState } from 'react'
import { playControl, usePlayControl } from '../../game/playControl'
import { Button, Modal } from '../widgets'

const NAMES = { local: 'Local game', practice: 'Practice', host: 'Player-hosted game', p2p: 'Player-hosted game', join: 'Online game', server: 'Custom game', casual: 'Casual game', ranked: 'Ranked game' }
export function PlayControlPrompt() {
  const conflict = usePlayControl((state) => state.conflict)
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(null)
  if (!conflict) return null
  const close = () => { if (!busy) { playControl.dismiss(); setProblem(null) } }
  const move = async () => {
    setBusy(true); setProblem(null)
    try { await playControl.takeover() }
    catch (error) { setProblem(error instanceof Error ? error.message : 'Could not move your game.') }
    finally { setBusy(false) }
  }
  const canResume = conflict.target.region && conflict.target.code && ['server', 'casual', 'ranked', 'join'].includes(conflict.target.mode)
  return <Modal title="Game already open" onClose={close} escDisabled={busy} width="max-w-md" footer={<div className="flex justify-end gap-3"><Button disabled={busy} onClick={close}>Back</Button><Button variant="primary" disabled={busy} onClick={() => void move()}>{busy ? 'Moving game…' : 'Use here'}</Button></div>}>
    <p className="mb-3 text-bone">{NAMES[conflict.target.mode]}{conflict.target.code ? ` · ${conflict.target.code}` : ''}</p>
    <p className="text-ash">One game at a time per account or browser. {canResume ? 'Use here will disconnect the other tab or device and reopen that game here.' : conflict.target.mode === 'host' ? 'Use here ends the game hosted in the other tab before opening your new game. Other players in that hosted game will disconnect.' : 'Use here stops the other session before opening your new game. Local games restart when moved.'}</p>
    {busy && <p role="status" className="mt-3 text-ash">Waiting for the other session to stop. If it lost its connection, this can take about 30 seconds.</p>}
    {problem && <p role="alert" className="mt-4 text-red-200">{problem}</p>}
  </Modal>
}
