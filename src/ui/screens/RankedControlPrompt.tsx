import { useState } from 'react'
import { useRankedControl } from '../../game/rankedControl'
import { online } from '../../game/session'
import { useGame } from '../../game/store'
import { Button, Modal } from '../widgets'
import { continueRankedHere } from '../flow'

export function RankedControlPrompt() {
  const conflict = useRankedControl((state) => state.conflict)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (!conflict) return null
  const close = () => { if (!busy) { useRankedControl.setState({ conflict: null }); setProblem(null) } }
  const region = online.region(conflict.game.region)?.label ?? conflict.game.region
  const takeOver = async () => {
    setBusy(true); setProblem(null)
    try {
      await continueRankedHere(conflict.game)
      const lobby = useGame.getState().lobby
      if (lobby.status !== 'open') throw new Error(lobby.error ?? 'Could not transfer your game. Try again.')
      useRankedControl.setState({ conflict: null })
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Could not transfer your game.') }
    finally { setBusy(false) }
  }
  return <Modal title={conflict.kind === 'controller' ? 'Your game is open elsewhere' : 'This browser is already in ranked'} onClose={close} width="max-w-md" escDisabled={busy} footer={<div className="flex justify-end gap-3"><Button disabled={busy} onClick={close}>Back</Button>{conflict.kind === 'controller' && <Button variant="primary" disabled={busy} onClick={() => void takeOver()} data-testid="use-here">{busy ? 'Moving your game…' : 'Use here'}</Button>}</div>}>
    <p className="mb-3 text-bone">{region} · Game {conflict.game.room}</p>
    <p className="text-ash">{conflict.kind === 'controller' ? 'Continue the same ranked game here. The other tab or device will disconnect, and you keep your current seat.' : 'Another account on this browser has a ranked game in progress. Finish that game, or sign back into its account to continue it. One browser cannot play both sides of a ranked match.'}</p>
    {problem && <p role="alert" className="mt-4 text-red-200">{problem}</p>}
  </Modal>
}
