import { dot, float, max, mix, smoothstep, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/** Scene-linear luminance anchors: keep black and emissive highlights in place,
 * open the cool stone/cloth midtones between them. One scalar preserves hue;
 * grading happens before the existing ACES/output transform, never on the HUD. */
export function gradeSceneColor(color: Node<'vec3'>): Node<'vec3'> {
  const luminance = dot(color, vec3(0.2126, 0.7152, 0.0722))
  const shadowDetail = smoothstep(0, 0.012, luminance)
  const brightest = max(max(color.r, color.g), color.b)
  const midtones = float(1).sub(smoothstep(0.12, 0.65, brightest))
  const gain = mix(float(0.97), float(1), shadowDetail).add(shadowDetail.mul(midtones).mul(0.10))
  return color.mul(gain)
}
