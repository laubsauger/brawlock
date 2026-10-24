import type { Object3D, Vector3 } from 'three/webgpu'
export class ClothProxy {
  readonly rest: Vector3[]
  readonly position: Vector3[]
  readonly data: { region: number[]; triangles: number[][] }
  readonly capsules: { a: Vector3; b: Vector3; radius: number; kind: string }[]
  constructor(data: unknown, actor: Object3D, definitions: unknown)
  update(dt: number): void
  reset(): void
}
export const MAX_CLOTH_STEP: number
