import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, type CSSProperties } from 'react'
import * as THREE from 'three/webgpu'

let updateErrorLogged = false
import { useGame } from '../game/store'
import { startMockDriver } from './dev/mockDriver'
import { GpuCanvas, useEffectiveQuality } from './GpuCanvas'
import { tierConfig } from './quality'
import { RenderLoop } from './RenderLoop'
import { MatchWorld } from './scene/MatchWorld'
import { createPrivateSource } from './source'

/**
 * Animated lava-caldera backdrop for menu and lobby screens: a slow orbit
 * around the platform while two warlocks duel at a calm pace (private mock
 * buffer, never touches the match frame buffer), embers and bloom.
 */
export function MenuBackdrop({ className, style }: { className?: string; style?: CSSProperties }) {
  const quality = useGame((s) => s.settings.quality)
  const fx = useGame((s) => s.settings.fxIntensity)
  return (
    <div className={className} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#0b0604', ...style }}>
      <GpuCanvas quality={quality} style={{ position: 'absolute', inset: 0 }}>
        <MenuScene quality={quality} fx={fx} />
        <RenderLoop quality={quality} fx={fx} inspect={false} />
      </GpuCanvas>
    </div>
  )
}

function MenuScene({ quality, fx }: { quality: Parameters<typeof tierConfig>[0]; fx: number }) {
  const scene = useThree((s) => s.scene)
  const gl = useThree((s) => s.gl)
  const eff = useEffectiveQuality(quality)
  const worldRef = useRef<MatchWorld | null>(null)

  useEffect(() => {
    const source = createPrivateSource()
    const stop = startMockDriver(source, { calm: true })
    const tierCfg = tierConfig(eff)
    const r = gl as unknown as THREE.WebGPURenderer
    r.shadowMap.enabled = tierCfg.shadowMap > 0
    r.shadowMap.type = THREE.PCFShadowMap
    const world = new MatchWorld({ source, tier: tierConfig(eff), fx, overlayParent: null, mode: 'menu', renderer: r })
    scene.add(world.root)
    scene.background = new THREE.Color(0x0b0604)
    scene.fogNode = world.fogNode
    worldRef.current = world
    return () => {
      stop()
      scene.remove(world.root)
      scene.fogNode = null
      world.dispose()
      worldRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, eff, gl])

  useEffect(() => {
    worldRef.current?.setFx(fx)
  }, [fx])

  useFrame((state, dt) => {
    try {
      worldRef.current?.update(Math.min(dt, 0.1), state.camera as THREE.PerspectiveCamera, state.size.width / Math.max(1, state.size.height))
    } catch (err) {
      if (!updateErrorLogged) console.error('[render] menu world update threw', err)
      updateErrorLogged = true
    }
  })
  return null
}
