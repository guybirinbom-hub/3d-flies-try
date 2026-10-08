import * as THREE from 'three';
import type { MatKey } from './builder';

/**
 * Shared materials. Base colour is white everywhere: the actual colour comes
 * from per-vertex colours painted by the part builders, which keeps a whole
 * village to a handful of materials and exports cleanly to glTF.
 */
export function createMaterials(): Record<MatKey, THREE.Material> {
  const std = (name: MatKey, roughness: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
    Object.assign(new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0, ...extra }), { name });

  return {
    stone: std('stone', 0.92),
    mortar: std('mortar', 1),
    plaster: std('plaster', 0.95),
    timber: std('timber', 0.85),
    wood: std('wood', 0.8),
    trim: std('trim', 0.7),
    roof: std('roof', 0.78),
    glass: std('glass', 0.08, { metalness: 0.1, envMapIntensity: 1.4 }),
    metal: std('metal', 0.45, { metalness: 0.75 }),
    foliage: std('foliage', 0.9),
    flower: std('flower', 0.75),
    glow: std('glow', 0.5, { emissive: new THREE.Color('#ffc46b'), emissiveIntensity: 1.6 }),
  };
}
