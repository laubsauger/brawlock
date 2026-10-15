import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useGame, type CastMode, type Quality } from '../game/store'
import { Button, Kbd, Modal, Row, Segmented, Slider, Switch } from './widgets'
import { ACTION_LABEL, BIND_GROUPS, bindLabel, keyLabel, PRESET_INFO, resolveBinds, type BindAction } from './lib/keys'
import { forcedSynth, sfx } from './lib/sound'
import { assignKey, clearSecondary, resetSlotLayout } from './lib/remap'
import { toggleFullscreen, useFullscreen } from './lib/fullscreen'
import { slotDragProps } from './lib/slotDnd'
import { audio } from '../audio'
import { chooseName } from './lib/name'

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
    <section className="mb-6">
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

/**
 * Two keys per action. Drag a spell or item row onto another to swap their keys. Click a key cell, then press the new key (Delete or
 * Backspace clears a secondary, Esc cancels). Taking a key that is already
 * bound anywhere (primary or secondary) moves it: the other action gets this
 * cell's old key, or loses that key if this cell was empty.
 */
function Keybinds({ onCapture }: { onCapture: (on: boolean) => void }) {
  const preset = useGame((st) => st.settings.keyPreset)
  const keybinds = useGame((st) => st.settings.keybinds)
  const keybindsAlt = useGame((st) => st.settings.keybindsAlt)
  const castMode = useGame((st) => st.settings.castMode)
  const castModeSlots = useGame((st) => st.settings.castModeSlots)
  const setSettings = useGame((st) => st.setSettings)
  const binds = useMemo(() => resolveBinds({ keyPreset: preset, keybinds, keybindsAlt }), [preset, keybinds, keybindsAlt])
  const [capturing, setCapturing] = useState<{ action: BindAction; which: Which } | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    onCapture(capturing !== null)
    if (!capturing) return
    const { action, which } = capturing
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.code === 'Escape') {
        setCapturing(null)
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
        setCapturing(null)
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
      setCapturing(null)
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
          setCapturing(on ? null : { action: a, which })
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
        <div className="well grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-1 px-4 py-3">
          <span className="text-[0.95rem] text-ash">Move: right click (hold to keep moving)</span>
          <span className="text-center text-[0.8rem] font-semibold text-ash">Key</span>
          <span className="text-center text-[0.8rem] font-semibold text-ash">Second key</span>
          <span />
          {BIND_GROUPS.map((g) => (
            <div key={g.title} className="contents">
              <span className="col-span-4 mt-2 text-[0.98rem] font-bold text-[#ffd890]">{g.title}</span>
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
                        className="field w-32 py-1 text-[0.92rem]"
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
                      <span />
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          <span className="col-span-4 mt-2 text-[0.9rem] text-ash">
            Fixed: <Kbd>Esc</Kbd> menu and cancel, <Kbd>F2</Kbd> performance overlay, <Kbd>F3</Kbd> net graph
          </span>
        </div>
        <div className="mt-2 flex min-h-8 items-center justify-between gap-3">
          <p className="text-[0.92rem] text-[#ffcf9a]" aria-live="polite">
            {capturing
              ? `Press the new ${capturing.which === 'secondary' ? 'second ' : ''}key for ${ACTION_LABEL[capturing.action]}. ${capturing.which === 'secondary' ? 'Delete clears it. ' : ''}Esc cancels.`
              : note}
          </p>
          <span className="flex gap-1">
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

export function SettingsModal() {
  const s = useGame((st) => st.settings)
  const setSettings = useGame((st) => st.setSettings)
  const toggle = useGame((st) => st.toggle)
  const [name, setName] = useState(s.playerName)
  const [capturing, setCapturing] = useState(false)
  const fullscreen = useFullscreen()
  const close = useCallback(() => {
    if (name.trim() && name.trim() !== s.playerName) chooseName(name)
    toggle('settingsOpen', false)
  }, [name, s.playerName, toggle])

  return (
    <Modal title="Settings" onClose={close} escDisabled={capturing}>
      <Section title="Graphics">
        <Row label="Quality" hint={QUALITY_HINT[s.quality]}>
          <Segmented label="Quality" value={s.quality} options={QUALITY} onChange={(quality) => setSettings({ quality })} />
        </Row>
        <Row label="Fullscreen" hint="Also Alt+Enter at any time">
          <Switch label="Fullscreen" checked={fullscreen} onChange={() => void toggleFullscreen()} />
        </Row>
        <Row label="Effects intensity" hint="Screen shake, flashes and post effects">
          <div className="w-56">
            <Slider label="Effects intensity" value={s.fxIntensity} onChange={(fxIntensity) => setSettings({ fxIntensity })} />
          </div>
        </Row>
      </Section>

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

      <Section title="Controls">
        <Keybinds onCapture={setCapturing} />
      </Section>

      <Section title="Interface">
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
        <Row label="HUD layout" hint={s.hudLayout === 'right' ? 'Bars and spells sit in the bottom-right corner; the center stays clear' : 'Bars and spells centered at the bottom, as in Dota'}>
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
        <Row label="Performance overlay" hint="Frame rate, frame time, GPU time and ping. Also F2">
          <Switch label="Performance overlay" checked={s.showPerf} onChange={(showPerf) => setSettings({ showPerf })} />
        </Row>
        <Row label="Net graph" hint="Ping, jitter and packet loss per connection over the last 30 seconds. Also F3">
          <Switch label="Net graph" checked={!!s.netGraph} onChange={(netGraph) => setSettings({ netGraph })} />
        </Row>
      </Section>
    </Modal>
  )
}
