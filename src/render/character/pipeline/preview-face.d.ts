import type { ColorRepresentation, Mesh, MeshBasicNodeMaterial, Object3D } from 'three/webgpu'
export function attachPreviewFace(actor: Object3D, color: ColorRepresentation, phase?: number): {
  mesh: Mesh<import('three/webgpu').BufferGeometry, MeshBasicNodeMaterial>
  setColor(color: ColorRepresentation): void
  update(dt: number): void
  blink(): void
  dispose(): void
}
