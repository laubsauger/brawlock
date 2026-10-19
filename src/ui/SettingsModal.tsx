import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useGame, type CastMode, type Quality, type Settings } from '../game/store'
import { Button, Kbd, Modal, Row, Segmented, Slider, Switch } from './widgets'
import { ACTION_LABEL, BIND_GROUPS, bindLabel, keyLabel, PRESET_INFO, resolveBinds, type BindAction } from './lib/keys'
import { forcedSynth, sfx } from './lib/sound'
import { assignKey, clearSecondary, resetSlotLayout } from './lib/remap'
import { toggleFullscreen, useFullscreen } from './lib/fullscreen'
import { slotDragProps } from './lib/slotDnd'
import { audio } from '../audio'
import { chooseName } from './lib/name'
import { online } from '../game/session'
import { pickRegion, useRegionChoice, useRegions } from './lib/servers'
import { RegionPing } from './RegionPing'

const FPS_CAPS = [
  { value: '0', label: 'Off' },
  { value: '30', label: '30' },
  { value: '60', label: '60' },
  { value: '120', label: '120' },
  { value: '144', label: '144' },
]

const QUALITY: { value: Quality; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
]

const QUALITY_HINT: Record<Quality, string> = {
  low: 'Lowest resolution and effects. For older laptops.',
  medium: 'Bloom and one shadow cascade.',
  high: 'Soft shadows, ambient occlusion and heat haze.',
  ultra: 'Native resolution and every effect.',
}

const CAST_MODES: { value: CastMode; label: string }[] = [
  { value: 'quick', label: 'Quick cast' },
  { value: 'release', label: 'On release' },
  { value: 'normal', label: 'Normal' },
]

const CAST_HINT: Record<CastMode, string> = {
  quick: 'The key casts at the cursor at once.',
  release: 'Hold the key to aim with a range ring, release to cast.',
  normal: 'The key starts aiming. Left click casts, right click or Esc cancels.',
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section mb-5 last:mb-0">
      <h3 className="section-title mb-1">{title}</h3>
      <div className="divide-y divide-[rgba(255,170,100,0.07)]">{children}</div>
    </section>
  )
}

function slotIndex(a: BindAction): number {
  if (a.startsWith('spell')) return Number(a.slice(5))
  if (a.startsWith('item')) return 6 + Number(a.slice(4))
  return -1
}

type Which = 'primary' | 'secondary'
type KeyCapture = { action: BindAction; which: Which }
type SettingsTab = 'gameplay' | 'controls' | 'video' | 'audio' | 'interface'
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'controls', label: 'Controls' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'interface', label: 'Interface' },
]

/**
 * Two keys per action. Drag a spell or item row onto another to swap their keys. Click a key cell, then press the new key (Delete or
 * Backspace clears a secondary, Esc cancels). Taking a key that is already
 * bound anywhere (primary or secondary) moves it: the other action gets this
 * cell's old key, or loses that key if this cell was empty.
 */
function Keybinds({ capturing, onCapture }: { capturing: KeyCapture | null; onCapture: (capture: KeyCapture | null) => void }) {
  const preset = useGame((st) => st.settings.keyPreset)
  const keybinds = useGame((st) => st.settings.keybinds)
  const keybindsAlt = useGame((st) => st.settings.keybindsAlt)
  const castMode = useGame((st) => st.settings.castMode)
  const castModeSlots = useGame((st) => st.settings.castModeSlots)
  const setSettings = useGame((st) => st.setSettings)
  const binds = useMemo(() => resolveBinds({ keyPreset: preset, keybinds, keybindsAlt }), [preset, keybinds, keybindsAlt])
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!capturing) return
    const { action, which } = capturing
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.code === 'Escape') {
        onCapture(null)
        return
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        if (which === 'primary') {
          sfx('error')
          setNote('Every action keeps a main key. Rebind it instead, or clear the second key.')
          return
        }
        clearSecondary(action)
        setNote(`${ACTION_LABEL[action]} has no second key now.`)
        onCapture(null)
        return
      }
      const r = assignKey(action, which, e.code)
      if (!r.ok) {
        sfx('error')
        setNote(r.note)
        return
      }
      sfx('click')
      setNote(r.note)
      onCapture(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, onCapture])

  const slotCustom = [...Object.keys(keybinds ?? {}), ...Object.keys(keybindsAlt ?? {})].some((k) => /^(spell|item)\d$/.test(k))
  const custom = Object.keys(keybinds ?? {}).length > 0 || Object.keys(keybindsAlt ?? {}).length > 0 || Object.keys(castModeSlots ?? {}).length > 0
  const preset_ = PRESET_INFO.find((p) => p.value === preset)

  const cell = (a: BindAction, which: Which, label: string) => {
    const on = capturing?.action === a && capturing.which === which
    const code = binds[which][a]
    return (
      <button
        type="button"
        className={`kbd h-8 min-w-[5rem] px-2 text-[0.92rem] ${on ? 'animate-pulse ring-2 ring-gold' : 'hover:brightness-125'} ${!code && !on ? 'opacity-60' : ''}`}
        aria-label={`${label}, ${which === 'primary' ? 'main' : 'second'} key: ${code ? keyLabel(code) : 'none'}. Click to change`}
        onClick={() => {
          setNote(null)
          onCapture(on ? null : { action: a, which })
        }}
      >
        {on ? 'Press a key' : code ? keyLabel(code) : '–'}
      </button>
    )
  }

  return (
    <>
      <Row label="Preset" hint={preset_?.hint}>
        <Segmented
          label="Hotkey preset"
          value={preset}
          options={PRESET_INFO.map((p) => ({ value: p.value, label: p.label }))}
          onChange={(keyPreset) => {
            const hadCustom = Object.keys(keybinds ?? {}).length + Object.keys(keybindsAlt ?? {}).length > 0
            setSettings({ keyPreset, keybinds: {}, keybindsAlt: {} })
            setNote(hadCustom ? 'Custom keys were cleared for the new preset.' : null)
          }}
        />
      </Row>
      <Row label="Cast mode" hint={CAST_HINT[castMode]}>
        <Segmented label="Cast mode" value={castMode} options={CAST_MODES} onChange={(m) => setSettings({ castMode: m })} />
      </Row>
      <div className="py-2">
        <div className="well grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:gap-x-3 sm:px-4">
          <span className="text-[0.95rem] text-ash">Move: right click (hold to keep moving)</span>
          <span className="text-center text-[0.8rem] font-semibold text-ash">Key</span>
          <span className="text-center text-[0.8rem] font-semibold text-ash">Second key</span>
          <span className="hidden sm:block" />
          {BIND_GROUPS.map((g) => (
            <div key={g.title} className="contents">
              <span className="col-span-3 sm:col-span-4 mt-2 text-[0.98rem] font-bold text-[#ffd890]">{g.title}</span>
              {g.actions.map((a) => {
                const slot = slotIndex(a.id)
                const mode = slot >= 0 ? castModeSlots?.[slot] : undefined
                return (
                  <div key={a.id} className="contents">
                    {slot >= 0 ? (
                      <span className="bind-row truncate rounded px-1 text-[0.98rem]" title="Drag onto another row of this group to swap keys" {...slotDragProps(slot)}>
                        <span className="mr-1.5 text-ash" aria-hidden>
                          ⋮⋮
                        </span>
                        {a.label}
                      </span>
                    ) : (
                      <span className="truncate text-[0.98rem]">{a.label}</span>
                    )}
                    {cell(a.id, 'primary', a.label)}
                    {cell(a.id, 'secondary', a.label)}
                    {slot >= 0 ? (
                      <select
                        className="field col-span-3 mb-1 w-full py-1 text-[0.92rem] sm:col-span-1 sm:mb-0 sm:w-32"
                        aria-label={`Cast mode for ${a.label}`}
                        value={mode ?? ''}
                        onChange={(e) => {
                          const v = e.target.value as CastMode | ''
                          const next = { ...castModeSlots }
                          if (v) next[slot] = v
                          else delete next[slot]
                          setSettings({ castModeSlots: next })
                        }}
                      >
                        <option value="">Default</option>
                        {CAST_MODES.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="hidden sm:block" />
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          <span className="col-span-3 sm:col-span-4 mt-2 text-[0.9rem] text-ash">
            Fixed: <Kbd>Esc</Kbd> menu and cancel, <Kbd>F2</Kbd> performance overlay, <Kbd>F3</Kbd> net graph
          </span>
        </div>
        <div className="mt-2 flex min-h-8 flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
          <p className="text-[0.92rem] text-[#ffcf9a]" aria-live="polite">
            {capturing
              ? `Press the new ${capturing.which === 'secondary' ? 'second ' : ''}key for ${ACTION_LABEL[capturing.action]}. ${capturing.which === 'secondary' ? 'Delete clears it. ' : ''}Esc cancels.`
              : note}
          </p>
          <span className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" disabled={!slotCustom} onClick={() => resetSlotLayout()}>
              Reset slot layout
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!custom}
              onClick={() => {
                setSettings({ keybinds: {}, keybindsAlt: {}, castModeSlots: {} })
                setNote(`Back to the ${preset_?.label ?? ''} preset.`)
              }}
            >
              Reset to preset
            </Button>
          </span>
        </div>
      </div>
    </>
  )
}

/**
 * Game-server region (only in builds with a server): Auto picks the lowest
 * ping among the regions that are up; each region shows its health and ping.
 */
function ServerRegionRow() {
  const statuses = useRegions(5000)
  const choice = useRegionChoice()
  const setSettings = useGame((s) => s.setSettings)
  const auto = pickRegion(statuses, 'auto')
  const option = (value: string, label: ReactNode, right: ReactNode) => (
    <button
      key={value}
      type="button"
      className="region-opt flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-left"
      aria-pressed={choice === value}
      onClick={() => setSettings({ serverRegion: value })}
    >
      <span className="font-semibold">{label}</span>
      {right}
    </button>
  )
  return (
    <Row label="Game server region" hint="Used when you host on the game server. Auto picks the lowest ping.">
      <div className="flex w-72 max-w-full flex-col gap-1" role="group" aria-label="Game server region">
        {option('auto', 'Auto (lowest ping)', <span className="text-[0.82rem] text-ash">{auto ? auto.label : '…'}</span>)}
        {statuses.map((r) => option(r.id, r.label, <RegionPing s={r} />))}
      </div>
    </Row>
  )
}

export function SettingsModal() {
  const s = useGame((st) => st.settings)
  const setSettings = useGame((st) => st.setSettings)
  const toggle = useGame((st) => st.toggle)
  const [name, setName] = useState(s.playerName)
  const [capturing, setCapturing] = useState<KeyCapture | null>(null)
  const [tab, setTab] = useState<SettingsTab>('gameplay')
  const tabList = useRef<HTMLDivElement>(null)
  const fullscreen = useFullscreen()
  const close = useCallback(() => {
    if (name.trim() && name.trim() !== s.playerName) chooseName(name)
    toggle('settingsOpen', false)
  }, [name, s.playerName, toggle])

  const selectTab = (next: SettingsTab) => {
    // Capturing belongs to the Controls panel. Dropping it before that panel
    // unmounts also restores the dialog's normal Escape behavior immediately.
    setCapturing(null)
    if (tabList.current?.parentElement) tabList.current.parentElement.scrollTop = 0
    setTab(next)
  }
  const navigateTabs = (event: ReactKeyboardEvent<HTMLButtonElement>, current: SettingsTab) => {
    const index = SETTINGS_TABS.findIndex(({ id }) => id === current)
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % SETTINGS_TABS.length
    else if (event.key === 'ArrowLeft') next = (index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = SETTINGS_TABS.length - 1
    else return
    event.preventDefault()
    const target = SETTINGS_TABS[next].id
    selectTab(target)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#settings-tab-${target}`)?.focus()
  }

  return (
    <Modal title="Settings" width="max-w-4xl" className="h-[min(760px,92dvh)]" onClose={close} escDisabled={capturing !== null}>
      <div ref={tabList} role="tablist" aria-label="Settings categories" className="sticky top-0 z-10 mb-5 flex flex-wrap gap-1 border-b border-[#b58b55]/20 bg-[#21150f] py-2">
        {SETTINGS_TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-controls={`settings-panel-${id}`}
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={`rounded px-3 py-2 font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-gold ${tab === id ? 'bg-gold/15 text-[#ffd890]' : 'text-ash hover:bg-white/5 hover:text-bone'}`}
            onClick={() => selectTab(id)}
            onKeyDown={(event) => navigateTabs(event, id)}
          >
            {label}
          </button>
        ))}
      </div>
      {SETTINGS_TABS.map(({ id }) => (
        <div
          key={id}
          role="tabpanel"
          id={`settings-panel-${id}`}
          aria-labelledby={`settings-tab-${id}`}
          hidden={tab !== id}
          tabIndex={0}
          className="outline-none max-sm:[&_.seg]:flex-wrap max-sm:[&_.settings-section>div>div.flex]:flex-col max-sm:[&_.settings-section>div>div.flex]:items-stretch max-sm:[&_.settings-section>div>div.flex]:gap-2 max-sm:[&_.settings-section>div>div.flex]:py-3"
        >
          {tab === id && id === 'gameplay' && (<>
            <Section title="Gameplay">
              <Row
                label="Move cancels cast"
                hint={(s.moveCancelsCast ?? true) ? 'On: right-click during a cast cancels it' : 'Off: right-click during a cast queues the move until the spell goes off'}
              >
                <Switch label="Move cancels cast" checked={s.moveCancelsCast ?? true} onChange={(moveCancelsCast) => setSettings({ moveCancelsCast })} />
              </Row>
              <Row label="Player name">
                <input
                  className="field w-56"
                  maxLength={16}
                  spellCheck={false}
                  aria-label="Player name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setName(name.trim() ? chooseName(name) : s.playerName)}
                />
              </Row>
              <Row label="Camera reach" hint="How far edge pan and camera peek (hold A or the middle mouse button) can look away from your warlock">
                <Segmented
                  label="Camera reach"
                  value={s.cameraReach ?? 'normal'}
                  options={[
                    { value: 'short', label: 'Short' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'far', label: 'Far' },
                  ]}
                  onChange={(cameraReach) => setSettings({ cameraReach })}
                />
              </Row>
              <Row label="Edge pan" hint="Point at the screen edge to pan the camera that way. Camera peek still works when this is off">
                <Switch label="Edge pan" checked={s.edgePan ?? true} onChange={(edgePan) => setSettings({ edgePan })} />
              </Row>
              <Row label="Edge pan speed" hint={(s.edgePan ?? true) ? 'How fast the camera pans at the screen edge' : 'Edge pan is off'}>
                <div className="w-56">
                  <Slider label="Edge pan speed" disabled={!(s.edgePan ?? true)} value={s.edgePanSpeed ?? 1} min={0.25} max={2} step={0.05} format={(v) => `×${v.toFixed(2).replace(/0$/, '')}`} onChange={(edgePanSpeed) => setSettings({ edgePanSpeed })} />
                </div>
              </Row>
            </Section>

            {online.configured && (
              <Section title="Online">
                <ServerRegionRow />
              </Section>
            )}
          </>)}
          {tab === id && id === 'controls' && (<>
            <Section title="Controls">
              <Keybinds capturing={capturing} onCapture={setCapturing} />
            </Section>
          </>)}
          {tab === id && id === 'video' && (<>
            <Section title="Graphics">
              <Row label="Quality" hint={QUALITY_HINT[s.quality]}>
                <Segmented label="Quality" value={s.quality} options={QUALITY} onChange={(quality) => setSettings({ quality })} />
              </Row>
              <Row label="Fullscreen" hint="Also Alt+Enter at any time">
                <Switch label="Fullscreen" checked={fullscreen} onChange={() => void toggleFullscreen()} />
              </Row>
              <Row label="Effects intensity" hint="Flashes and post effects">
                <div className="w-56">
                  <Slider label="Effects intensity" value={s.fxIntensity} onChange={(fxIntensity) => setSettings({ fxIntensity })} />
                </div>
              </Row>
              <Row label="Screen shake" hint={(s.screenShake ?? 1) === 0 ? 'Off: the camera never shakes' : 'Camera shake and hit kick'}>
                <div className="w-56">
                  <Slider label="Screen shake" value={s.screenShake ?? 1} onChange={(screenShake) => setSettings({ screenShake })} />
                </div>
              </Row>
              <Row label="Frame rate limit" hint={(s.fpsCap ?? 0) === 0 ? 'Runs at your display refresh rate' : `At most ${s.fpsCap} frames per second; saves power and heat`}>
                <Segmented label="Frame rate limit" value={String(s.fpsCap ?? 0)} options={FPS_CAPS} onChange={(v) => setSettings({ fpsCap: Number(v) as Settings['fpsCap'] })} />
              </Row>
              <Row label="Resolution scale" hint="Lower renders fewer pixels: smoother on weak GPUs, softer image">
                <div className="w-56">
                  <Slider label="Resolution scale" value={s.resolutionScale ?? 1} min={0.5} max={1} step={0.05} onChange={(resolutionScale) => setSettings({ resolutionScale })} />
                </div>
              </Row>
            </Section>
          </>)}
          {tab === id && id === 'audio' && (<>
            <Section title="Audio">
              <Row label="Mute" hint={`Also with ${bindLabel(resolveBinds(s), 'mute')} at any time`}>
                <Switch label="Mute" checked={s.muted} onChange={(muted) => setSettings({ muted })} />
              </Row>
              <Row label="Master">
                <div className="w-56">
                  <Slider label="Master volume" value={s.masterVolume} onChange={(masterVolume) => setSettings({ masterVolume })} />
                </div>
              </Row>
              <Row label="Effects">
                <div className="w-56">
                  <Slider label="Effects volume" value={s.sfxVolume} onChange={(sfxVolume) => setSettings({ sfxVolume })} />
                </div>
              </Row>
              <Row label="Music">
                <div className="w-56">
                  <Slider label="Music volume" value={s.musicVolume} onChange={(musicVolume) => setSettings({ musicVolume })} />
                </div>
              </Row>
              <Row label="Ambience" hint="The lava bed: rumble, bubbling and sizzle">
                <div className="w-56">
                  <Slider label="Ambience volume" value={s.ambienceVolume} onChange={(ambienceVolume) => setSettings({ ambienceVolume })} />
                </div>
              </Row>
              <Row label="Announcer" hint="First Blood, multi-kills and kill streaks">
                <div className="w-56">
                  <Slider label="Announcer volume" value={s.announcerVolume ?? 0.8} onChange={(announcerVolume) => setSettings({ announcerVolume })} />
                </div>
              </Row>
              <Row label="Announcer voice" hint={(s.announcerVoice ?? 'maverick') === 'arena' ? 'A deep, gruff arena voice' : 'The heroic default voice'}>
                <Segmented
                  label="Announcer voice"
                  value={s.announcerVoice ?? 'maverick'}
                  options={[
                    { value: 'maverick', label: 'Maverick' },
                    { value: 'arena', label: 'Arena' },
                  ]}
                  onChange={(announcerVoice) => setSettings({ announcerVoice })}
                />
              </Row>
              <Row
                label="Sound style"
                hint={forcedSynth ? 'Synth only for this session (?audio=synth in the address)' : s.soundStyle === 'synth' ? 'Every sound synthesized live' : 'Recorded layers (lava, fire, impacts) over the synthesized sounds'}
              >
                <Segmented
                  label="Sound style"
                  value={forcedSynth ? 'synth' : (s.soundStyle ?? 'hybrid')}
                  disabled={forcedSynth}
                  options={[
                    { value: 'hybrid', label: 'Hybrid' },
                    { value: 'synth', label: 'Synth only' },
                  ]}
                  onChange={(soundStyle) => setSettings({ soundStyle })}
                />
              </Row>
              <Row label="Check your sound" hint={s.muted ? 'Sound is muted. Unmute to hear the test.' : 'Plays a chime, a fireball and an explosion at these volumes'}>
                <Button
                  size="sm"
                  sound={null}
                  onClick={() => {
                    try {
                      audio.test()
                    } catch (e) {
                      console.error('[ui] audio test failed', e)
                    }
                  }}
                >
                  Test sound
                </Button>
              </Row>
            </Section>
          </>)}
          {tab === id && id === 'interface' && (<>
            <Section title="Interface">
              <Row label="HUD layout" hint={s.hudLayout === 'right' ? 'Spells and items sit in the bottom-right corner; the center stays clear' : 'Spells and items centered along the bottom'}>
                <Segmented
                  label="HUD layout"
                  value={s.hudLayout ?? 'center'}
                  options={[
                    { value: 'center', label: 'Bottom center' },
                    { value: 'right', label: 'Bottom right' },
                  ]}
                  onChange={(hudLayout) => setSettings({ hudLayout })}
                />
              </Row>
              <Row label="HUD scale" hint="On top of the automatic scale for your screen size">
                <div className="w-56">
                  <Slider label="HUD scale" value={s.uiScale ?? 1} min={0.8} max={1.2} step={0.05} onChange={(uiScale) => setSettings({ uiScale })} />
                </div>
              </Row>
              <Row label="Colorblind-safe player colors" hint="Swaps the player and team colors for a palette that stays distinct with color vision deficiency, and adds a shape next to every name">
                <Switch label="Colorblind-safe player colors" checked={!!s.colorblindPalette} onChange={(colorblindPalette) => setSettings({ colorblindPalette })} />
              </Row>
              <Row label="Key hints" hint="The small key legend at the bottom left of a match">
                <Switch label="Key hints" checked={s.showHints ?? true} onChange={(showHints) => setSettings({ showHints })} />
              </Row>
              <Row label="Performance overlay" hint="Frame rate, frame time, GPU time and ping. Also F2">
                <Switch label="Performance overlay" checked={s.showPerf} onChange={(showPerf) => setSettings({ showPerf })} />
              </Row>
              <Row label="Net graph" hint="Ping, jitter, loss, local frame stalls and server load. Copy recent diagnostic samples. Also F3">
                <Switch label="Net graph" checked={!!s.netGraph} onChange={(netGraph) => setSettings({ netGraph })} />
              </Row>
            </Section>
          </>)}
        </div>
      ))}
    </Modal>
  )
}
