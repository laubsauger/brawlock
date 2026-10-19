import { useState } from 'react'
import { online } from '../../game/session'
import { useGame } from '../../game/store'
import { hostGame, hostOnServer, playOffline } from '../flow'
import { pickRegion, regionProblem, useRegionChoice, useRegions } from '../lib/servers'
import { RegionPing } from '../RegionPing'
import { Button, Modal } from '../widgets'

/** A single setup entry for solo play and hosting. Opening it never creates a room. */
export function PlaySetup({ initialOnline, onClose }: { initialOnline: boolean; onClose: () => void }) {
  const [multiplayer, setMultiplayer] = useState(initialOnline)
  const [location, setLocation] = useState<'server' | 'pc'>(online.configured ? 'server' : 'pc')
  const [listed, setListed] = useState(initialOnline)
  const regions = useRegions(5000)
  const choice = useRegionChoice()
  const setSettings = useGame((s) => s.setSettings)
  const region = pickRegion(regions, choice)
  const problem = multiplayer && location === 'server' ? regionProblem(region) : null
  const create = () => {
    onClose()
    if (!multiplayer) playOffline()
    else if (location === 'pc') hostGame(listed)
    else if (region) hostOnServer(choice === 'auto' ? 'auto' : region.id, listed)
  }
  return <Modal title="Custom game" onClose={onClose} width="max-w-lg" footer={<Button variant="primary" className="w-full" disabled={!!problem} onClick={create}>Create game</Button>}>
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3" role="group" aria-label="Players">
        <Button variant={!multiplayer ? 'primary' : 'default'} aria-pressed={!multiplayer} onClick={() => setMultiplayer(false)} className="min-h-16 flex-col gap-1">
          Solo <span className="font-ui text-sm font-normal text-ash">Practice with bots</span>
        </Button>
        <Button variant={multiplayer ? 'primary' : 'default'} aria-pressed={multiplayer} onClick={() => setMultiplayer(true)} className="min-h-16 flex-col gap-1">
          Online <span className="font-ui text-sm font-normal text-ash">Invite or meet players</span>
        </Button>
      </div>
      {multiplayer && <>
        <label className="flex flex-col gap-2 text-sm font-semibold text-ash">Host location
          <select className="field w-full text-base text-bone" value={location} onChange={(e) => setLocation(e.target.value as 'server' | 'pc')}>
            {online.configured && <option value="server">Game server</option>}
            <option value="pc">This computer</option>
          </select>
        </label>
        {location === 'server' ? <div className="flex flex-col gap-2">
          {regions.length > 1 && <label className="flex items-center justify-between gap-3 text-sm text-ash">Region
            <select className="field" aria-label="Game server region" value={choice} onChange={(e) => setSettings({ serverRegion: e.target.value })}>
              <option value="auto">Auto · lowest ping</option>
              {regions.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>}
          {region && <RegionPing s={region} withName />}
          {problem && <p role="status" className="text-sm text-[#ffb08a]">{problem}</p>}
        </div> : <p className="text-sm leading-snug text-ash">You host the room. Keep this tab open while your friends play.</p>}
        {online.configured && <label className="flex cursor-pointer items-center gap-3 text-sm text-bone">
          <input type="checkbox" className="h-4 w-4 accent-[#ffc548]" checked={listed} onChange={(e) => setListed(e.target.checked)} />
          List in Browse games
        </label>}
      </>}
      <p className="text-sm leading-snug text-ash">{multiplayer ? 'Share the room code, then choose bots and rules in the lobby.' : 'Choose your bots and rules in the lobby.'}</p>
    </div>
  </Modal>
}
