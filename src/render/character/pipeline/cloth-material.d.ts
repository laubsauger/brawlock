import type { MeshPhysicalNodeMaterial, MeshStandardMaterial, Object3D, SkinnedMesh } from 'three/webgpu'
import type { ClothProxy } from './cloth-proxy.js'
export function prepareClothAttributes(actor: Object3D): void
export function attachClothMaterial(mesh: SkinnedMesh, simulation: ClothProxy, enabled: unknown, attachLook: (material: MeshPhysicalNodeMaterial, source: MeshStandardMaterial) => void): void
