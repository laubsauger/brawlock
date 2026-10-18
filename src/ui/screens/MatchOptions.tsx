import type { ReactNode } from 'react'
import { DEFAULT_SETTINGS, type GameMode, type MatchSettings, type TeamMode } from '../../sim'
import { session } from '../../game/session'
import { Button, NumberField, Row, Segmented, Switch } from '../widgets'

/**
 * Every original lobby option (docs/research/systems.md §6.1), editable by
 * the host / offline player, read-only for clients. Defaults come from the
 * sim (DEFAULT_SETTINGS).
 */
const TEAM_MODES: { value: TeamMode; label: string }[] = [
  { value: 'shuffle', label: 'Shuffle' },
  { value: 'ffa', label: 'Free for all' },
  { value: 'teams', label: 'Teams' },
]

const GAME_MODES: { value: GameMode; label: string }[] = [
  { value: 'rounds', label: 'Rounds' },
  { value: 'deathmatch', label: 'Deathmatch' },
]

const TEAM_HINT: Record<TeamMode, string> = {
  shuffle: 'New random teams every round',
  ffa: 'Everyone for themselves',
  teams: 'Teams as set in the player list',
}

const MODE_HINT: Record<GameMode, string> = {
  rounds: 'Last team standing scores the round',
  deathmatch: '60 second rounds, respawn after 10 s, a point per kill',
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="section-title mb-1">{title}</h3>
      <div className="divide-y divide-[rgba(255,170,100,0.07)]">{children}</div>
    </section>
  )
}

export function MatchOptions({ settings, editable }: { settings: MatchSettings | null; editable: boolean }) {
  if (!settings) {
    return <p className="py-6 text-ash">Waiting for the match rules from the host…</p>
  }
  const set = (patch: Partial<MatchSettings>) => session.updateSettings(patch)
  const ro = !editable
  const isDefault = (Object.keys(DEFAULT_SETTINGS) as (keyof MatchSettings)[]).every((k) => settings[k] === DEFAULT_SETTINGS[k])

  return (
    <div>
      <Group title="Mode">
        <Row label="Teams" hint={TEAM_HINT[settings.teamMode]}>
          <Segmented label="Team mode" value={settings.teamMode} options={TEAM_MODES} disabled={ro} onChange={(teamMode) => set({ teamMode })} />
        </Row>
        <Row label="Game mode" hint={MODE_HINT[settings.gameMode]}>
          <Segmented label="Game mode" value={settings.gameMode} options={GAME_MODES} disabled={ro} onChange={(gameMode) => set({ gameMode })} />
        </Row>
        <Row label="Score to win" hint={settings.gameMode === 'rounds' ? 'Round wins needed to take the match' : 'Kills needed to take the match'}>
          <NumberField label="Score to win" value={settings.winScore} min={1} max={99} disabled={ro} onCommit={(winScore) => set({ winScore })} />
        </Row>
      </Group>

      <Group title="Gold">
        <Row label="Spectator betting" hint="Rounds: knocked-out players can wager 1 gold, with up to 2 gold returned">
          <Switch label="Spectator betting" checked={settings.spectatorBets} disabled={ro || settings.gameMode !== 'rounds'} onChange={(spectatorBets) => set({ spectatorBets })} />
        </Row>
        <Row label="Bounties" hint="Unpaid betting pots become winner bounties; a credited knockout claims them">
          <Switch label="Bounties" checked={settings.bounties} disabled={ro || settings.gameMode !== 'rounds'} onChange={(bounties) => set({ bounties })} />
        </Row>
        <Row label="Start gold" hint="Everyone gets this before the first shop">
          <NumberField label="Start gold" value={settings.startGold} min={0} max={9999} disabled={ro} onCommit={(startGold) => set({ startGold })} />
        </Row>
        <Row label="Round gold" hint="Paid to everyone after each round">
          <NumberField label="Round gold" value={settings.roundGold} min={0} max={9999} disabled={ro} onCommit={(roundGold) => set({ roundGold })} />
        </Row>
        <Row label="Kill gold" hint="Paid to the killer">
          <NumberField label="Kill gold" value={settings.killGold} min={0} max={9999} disabled={ro} onCommit={(killGold) => set({ killGold })} />
        </Row>
        <Row label="Win gold" hint="Paid to the round winners">
          <NumberField label="Win gold" value={settings.winGold} min={0} max={9999} disabled={ro} onCommit={(winGold) => set({ winGold })} />
        </Row>
        <Row label="Shop time" hint="Seconds to shop and warm up before each round">
          <NumberField label="Shop time in seconds" value={settings.shopSeconds} min={3} max={120} disabled={ro} onCommit={(shopSeconds) => set({ shopSeconds })} />
        </Row>
      </Group>

      <Group title="Physics">
        <Row label="Lava damage" hint="Damage per second while standing in lava">
          <NumberField label="Lava damage per second" value={settings.lavaDps} min={0} max={2000} disabled={ro} onCommit={(lavaDps) => set({ lavaDps })} />
        </Row>
        <Row label="Knockback multiplier" hint="Scales every push">
          <NumberField label="Knockback multiplier" value={settings.kbMultiplier} min={0} max={10} step={0.05} integer={false} disabled={ro} onCommit={(kbMultiplier) => set({ kbMultiplier })} />
        </Row>
        <Row label="Damage multiplier" hint="Scales every hit">
          <NumberField label="Damage multiplier" value={settings.dmgMultiplier} min={0} max={10} step={0.05} integer={false} disabled={ro} onCommit={(dmgMultiplier) => set({ dmgMultiplier })} />
        </Row>
        <Row label="Friction" hint="Speed kept per original tick. Lower stops you sooner (0.96 is classic)">
          <NumberField label="Friction" value={settings.friction} min={0.5} max={1} step={0.005} integer={false} disabled={ro} onCommit={(friction) => set({ friction })} />
        </Row>
      </Group>

      <Group title="Players">
        <Row label="Bots replace leavers" hint="A bot takes over anyone who disconnects">
          <Switch label="Bots replace leavers" checked={settings.botsReplaceLeavers} disabled={ro} onChange={(botsReplaceLeavers) => set({ botsReplaceLeavers })} />
        </Row>
      </Group>

      {editable && (
        <Button size="sm" variant="ghost" disabled={isDefault} onClick={() => set(DEFAULT_SETTINGS)}>
          Reset to defaults
        </Button>
      )}
    </div>
  )
}
