import { describe, expect, it } from 'vitest'
import { AnimationClip, Bone, Group, Quaternion, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three/webgpu'
import { prepareWarlockClips, relaxWarlockFingers } from './asset'

describe('canonical animation reuse', () => {
  const finger = new QuaternionKeyframeTrack('index_01_l.quaternion', [0, 1], [0, 0, .6, .8, 0, 0, .6, .8])
  const leg = new QuaternionKeyframeTrack('thigh_l.quaternion', [0], [0, 0, 0, 1])
  const arm = new QuaternionKeyframeTrack('upperarm_l.quaternion', [0], [0, 0, 0, 1])
  const translation = new VectorKeyframeTrack('pelvis.position', [0], [0, 1, 0])

  it('keeps moving legs separate from casting arms and preserves cast fingers', () => {
    const idle = new AnimationClip('idle', 1, [finger, leg, arm, translation])
    const cast = new AnimationClip('castEnter', 1, [finger, leg, arm, translation])
    const { clips } = prepareWarlockClips([idle, cast])
    expect(clips.idle.lo.tracks).toEqual([leg, translation])
    expect(clips.idle.up.tracks).toEqual([arm])
    expect(clips.castEnter.up.tracks).toEqual([finger, arm])
    expect(idle.tracks).toHaveLength(4)
    expect(clips.castEnter.full).toBe(cast)
  })

  it('uses the authored relaxed fingers before staff poses are built', () => {
    const model = new Group(), bone = new Bone()
    bone.name = 'index_01_l'; model.add(bone)
    relaxWarlockFingers(model, [new AnimationClip('idle', 1, [finger])])
    expect(bone.quaternion.angleTo(new Quaternion(0, 0, .6, .8))).toBeCloseTo(0)
    expect(() => relaxWarlockFingers(new Group(), [new AnimationClip('idle', 1, [finger])])).toThrow('finger joint missing')
  })

  it('builds additive hits from cloned rotations without mutating authored clips', () => {
    const hit = new AnimationClip('hit', 1, [finger, arm, translation])
    const before = Array.from(arm.values)
    const { additive } = prepareWarlockClips([hit])
    expect(additive.hit.tracks.map(t => t.name)).toEqual(['upperarm_l.quaternion'])
    expect(additive.hit.tracks[0]).not.toBe(arm)
    expect(Array.from(arm.values)).toEqual(before)
    expect(hit.tracks).toHaveLength(3)
  })
})
