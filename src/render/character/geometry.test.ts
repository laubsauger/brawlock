import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three/webgpu'
import { buildCloth, KIND, type RigRest } from './geometry'

function rig(backDepth: number): RigRest {
  const bones: Record<string, Vector3> = {
    pelvis: new Vector3(0, 1, 0),
    spine_01: new Vector3(0, 1.1, 0),
    spine_02: new Vector3(0, 1.25, 0),
    spine_03: new Vector3(0, 1.43, 0),
    neck_01: new Vector3(0, 1.63, 0),
  }
  for (const [tag, side] of [['l', 1], ['r', -1]] as const) {
    bones[`clavicle_${tag}`] = new Vector3(side * 0.1, 1.5, 0)
    bones[`upperarm_${tag}`] = new Vector3(side * 0.19, 1.5, 0)
    bones[`lowerarm_${tag}`] = new Vector3(side * 0.45, 1.49, 0)
    bones[`hand_${tag}`] = new Vector3(side * 0.7, 1.49, 0)
    bones[`thigh_${tag}`] = new Vector3(side * 0.1, 0.95, 0)
    bones[`calf_${tag}`] = new Vector3(side * 0.1, 0.5, 0)
    bones[`foot_${tag}`] = new Vector3(side * 0.1, 0.08, 0.08)
  }
  const names = Object.keys(bones)
  return {
    pos(name) {
      if (!bones[name]) throw new Error(`Missing test bone ${name}`)
      return bones[name].clone()
    },
    index: (name) => names.indexOf(name),
    slice: (_y0, _y1, part) => part === 'head'
      ? { minX: -0.12, maxX: 0.12, minZ: -0.11, maxZ: 0.11 }
      : { minX: -0.15, maxX: 0.15, minZ: -backDepth, maxZ: 0.15 },
  }
}

function mantleBack(backDepth: number): { t: number; z: number }[] {
  const geometry = buildCloth(rig(backDepth))
  const position = geometry.getAttribute('position')
  const cloth = geometry.getAttribute('aCloth')
  const uv = geometry.getAttribute('uv')
  const rows = new Map<number, number>()
  for (let i = 0; i < position.count; i++) {
    if (cloth.getZ(i) === KIND.mantle && Math.abs(uv.getX(i) - 0.5) < 1e-5) {
      rows.set(uv.getY(i), position.getZ(i))
    }
  }
  geometry.dispose()
  return [...rows].map(([t, z]) => ({ t, z })).sort((a, b) => a.t - b.t)
}

describe('shoulder mantle drape', () => {
  it('keeps the back hem close to a slim tunic without entering the torso capsule', () => {
    const hem = mantleBack(0.12).at(-1)!
    // neck centre is z=.01: .17 m torso capsule plus .01 m cloth clearance.
    expect(0.01 - hem.z).toBeCloseTo(0.18, 6)
    expect(hem.z).toBeLessThan(-0.12 - 0.018)
  })

  it('fits a deeper tunic instead of forcing the narrow profile through it', () => {
    const hem = mantleBack(0.23).at(-1)!
    expect(hem.z).toBeCloseTo(-0.23 - 0.018, 6)
  })

  it('continues draping through the final rows instead of reaching a rigid shelf early', () => {
    const rows = mantleBack(0.12).filter((row) => row.t >= 0.6)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].z).toBeLessThan(rows[i - 1].z - 0.0005)
    }
  })
})
