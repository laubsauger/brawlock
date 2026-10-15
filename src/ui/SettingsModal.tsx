import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useGame, type CastMode, type Quality } from '../game/store'
import { Button, Kbd, Modal, Row, Segmented, Slider, Switch } from './widgets'
import { ACTION_LABEL, BIND_GROUPS, keyLabel, PRESET_INFO, PRESETS, RESERVED_KEYS, resolveBinds, type BindAction } from './lib/keys'
import { sfx } from './lib/sound'
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

/**
 * Click a key to rebind it, then press the new key. Taking a key that is
 * already in use swaps the two bindings. Esc cancels.
 */
function Keybinds({ onCapture }: { onCapture: (on: boolean) => void }) {
  const preset = useGame((st) => st.settings.keyPreset)
  const keybinds = useGame((st) => st.settings.keybinds)
  const castMode = useGame((st) => st.settings.castMode)
  const castModeSlots = useGame((st) => st.settings.castModeSlots)
  const setSettings = useGame((st) => st.setSettings)
  const binds = useMemo(() => resolveBinds({ keyPreset: preset, keybinds }), [preset, keybinds])
  const [capturing, setCapturing] = useState<BindAction | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    onCapture(capturing !== null)
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      if (e.code === 'Escape') {
        setCapturing(null)
        return
      }
      if (RESERVED_KEYS.has(e.code)) {
        sfx('error')
        setNote(`${keyLabel(e.code)} is reserved. Pick another key.`)
        return
      }
      const next: Record<string, string> = { ...binds }
      const old = next[capturing]
      const clash = (Object.keys(next) as BindAction[]).find((k) => k !== capturing && next[k] === e.code)
      next[capturing] = e.code
      if (clash) next[clash] = old
      // store only what differs from the preset
      const base = PRESETS[preset]
      const overrides: Record<string, string> = {}
      for (const k of Object.keys(next) as BindAction[]) if (next[k] !== base[k]) overrides[k] = next[k]
      setSettings({ keybinds: overrides })
      sfx('click')
      setNote(clash ? `${keyLabel(e.code)} was on ${ACTION_LABEL[clash]}; that now uses ${keyLabel(old)}.` : null)
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, binds, preset, setSettings, onCapture])

  const custom = Object.keys(keybinds ?? {}).length > 0 || Object.keys(castModeSlots ?? {}).length > 0
  const preset_ = PRESET_INFO.find((p) => p.value === preset)

  return (
    <>
      <Row label="Preset" hint={preset_?.hint}>
        <Segmented
          label="Hotkey preset"
          value={preset}
          options={PRESET_INFO.map((p) => ({ value: p.value, label: p.label }))}
          onChange={(keyPreset) => {
            setSettings({ keyPreset, keybinds: {} })
            setNote(Object.keys(keybinds ?? {}).length ? 'Custom keys were cleared for the new preset.' : null)
          }}
        />
      </Row>
      <Row label="Cast mode" hint={CAST_HINT[castMode]}>
        <Segmented label="Cast mode" value={castMode} options={CAST_MODES} onChange={(m) => setSettings({ castMode: m })} />
      </Row>
      <div className="py-2">
        <div className="well grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1 px-4 py-3">
          <span className="text-[0.95rem] text-ash">Move: right click (hold to keep moving)</span>
          <span />
          <span />
          {BIND_GROUPS.map((g) => (
            <div key={g.title} className="contents">
              <span className="col-span-3 mt-2 text-[0.98rem] font-bold text-[#ffd890]">{g.title}</span>
              {g.actions.map((a) => {
                const slot = slotIndex(a.id)
                const mode = slot >= 0 ? castModeSlots?.[slot] : undefined
                const isCap = capturing === a.id
                return (
                  <div key={a.id} className="contents">
                    <span className="truncate text-[0.98rem]">{a.label}</span>
                    <button
                      type="button"
                      className={`kbd h-8 min-w-[5.5rem] px-2 text-[0.92rem] ${isCap ? 'animate-pulse ring-2 ring-gold' : 'hover:brightness-125'}`}
                      aria-label={`${a.label}: ${keyLabel(binds[a.id])}. Click to change`}
                      onClick={() => {
                        setNote(null)
                        setCapturing(isCap ? null : a.id)
                      }}
                    >
                      {isCap ? 'Press a key' : keyLabel(binds[a.id])}
                    </button>
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
          <span className="col-span-3 mt-2 text-[0.9rem] text-ash">
            Fixed: <Kbd>Esc</Kbd> menu and cancel, <Kbd>F2</Kbd> performance overlay
          </span>
        </div>
        <div className="mt-2 flex min-h-8 items-center justify-between gap-3">
          <p className="text-[0.92rem] text-[#ffcf9a]" aria-live="polite">
            {capturing ? `Press the new key for ${ACTION_LABEL[capturing]}. Esc cancels.` : note}
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={!custom}
            onClick={() => {
              setSettings({ keybinds: {}, castModeSlots: {} })
              setNote(`Back to the ${preset_?.label ?? ''} preset.`)
            }}
          >
            Reset to preset
          </Button>
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
        <Row label="Effects intensity" hint="Screen shake, flashes and post effects">
          <div className="w-56">
            <Slider label="Effects intensity" value={s.fxIntensity} onChange={(fxIntensity) => setSettings({ fxIntensity })} />
          </div>
        </Row>
      </Section>

      <Section title="Audio">
        <Row label="Mute" hint={`Also with ${keyLabel(resolveBinds(s).mute)} at any time`}>
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
        <Row label="Performance overlay" hint="Frame rate, frame time, GPU time and ping. Also F2">
          <Switch label="Performance overlay" checked={s.showPerf} onChange={(showPerf) => setSettings({ showPerf })} />
        </Row>
      </Section>
    </Modal>
  )
}
