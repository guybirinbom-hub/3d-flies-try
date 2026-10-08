import * as THREE from 'three';
import type { HouseLayout } from '../gen/layout';
import { wallPoint } from '../gen/layout';

export const CAMERA_PRESETS = [
  'iso',
  'iso2',
  'front',
  'back',
  'left',
  'right',
  'top',
  'door',
  'eave',
  'low',
  // close-ups for reviewing joints
  'corner',
  'stoop',
  'peak',
  'chimney',
] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];

/** Position + target for a named viewpoint around a house. */
export function cameraFor(
  preset: CameraPreset,
  layout: HouseLayout,
  fovDeg: number,
  aspect: number,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const { min, max } = layout.bounds;
  const size = max.clone().sub(min);
  const target = new THREE.Vector3(0, max.y * 0.42, 0);
  const radius = Math.max(size.x, size.y, size.z) * 0.62;
  const fov = (fovDeg * Math.PI) / 180;
  const fitFov = aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * aspect) : fov;
  const dist = (radius / Math.sin(fitFov / 2)) * 1.0;

  const from = (dx: number, dy: number, dz: number, d = dist) =>
    target.clone().add(new THREE.Vector3(dx, dy, dz).normalize().multiplyScalar(d));

  switch (preset) {
    case 'iso':
      return { position: from(0.95, 0.5, 1.15), target };
    case 'iso2':
      return { position: from(-1.05, 0.45, 1.0), target };
    case 'front':
      return { position: from(0, 0.22, 1), target };
    case 'back':
      return { position: from(-0.6, 0.4, -1), target };
    case 'left':
      return { position: from(-1, 0.25, 0.12), target };
    case 'right':
      return { position: from(1, 0.25, 0.12), target };
    case 'top':
      return { position: from(0.02, 1, 0.35), target };
    case 'low':
      return { position: from(0.7, 0.08, 1.0, dist * 0.8), target: target.clone().setY(max.y * 0.5) };
    case 'door': {
      const d = layout.door;
      const wall = layout.walls.find((w) => w.id === d.wallId)!;
      const c = wallPoint(wall, (d.u0 + d.u1) / 2, (d.y0 + d.y1) / 2, 0);
      const n = new THREE.Vector3(wall.normal.x, 0, wall.normal.z);
      const side = new THREE.Vector3(wall.dir.x, 0, wall.dir.z);
      return {
        position: c.clone().add(n.multiplyScalar(4.2)).add(side.multiplyScalar(1.6)).add(new THREE.Vector3(0, 0.6, 0)),
        target: c,
      };
    }
    case 'eave': {
      const r = layout.roof;
      const c = new THREE.Vector3(r.maxX, r.eaveY + 0.6, r.halfDepth);
      return { position: c.clone().add(new THREE.Vector3(3.2, 0.6, 3.4)), target: c };
    }
    case 'corner': {
      // Front-right corner at plinth level: plinth, quoins / corner posts.
      const s0 = layout.storeys[0];
      const c = new THREE.Vector3(s0.maxX, s0.floorY + 0.6, s0.maxZ);
      return { position: c.clone().add(new THREE.Vector3(2.0, 0.5, 2.3)), target: c };
    }
    case 'stoop': {
      const d = layout.door;
      const wall = layout.walls.find((w) => w.id === d.wallId)!;
      const c = wallPoint(wall, (d.u0 + d.u1) / 2, layout.stoop.topY, 0.3);
      const n = new THREE.Vector3(wall.normal.x, 0, wall.normal.z);
      const side = new THREE.Vector3(wall.dir.x, 0, wall.dir.z);
      return {
        position: c.clone().add(n.multiplyScalar(2.6)).add(side.multiplyScalar(-1.4)).add(new THREE.Vector3(0, 1.1, 0)),
        target: c,
      };
    }
    case 'peak': {
      // Right gable apex: barge boards, ridge end, gable framing.
      const r = layout.roof;
      const c = new THREE.Vector3(r.maxX, r.ridgeY - 0.4, 0);
      return { position: c.clone().add(new THREE.Vector3(3.6, -0.2, 2.6)), target: c };
    }
    case 'chimney': {
      const ch = layout.chimney;
      if (!ch) return cameraFor('iso', layout, fovDeg, aspect);
      const c = new THREE.Vector3(ch.x, ch.y1 - 0.9, ch.z);
      return { position: c.clone().add(new THREE.Vector3(Math.sign(ch.x || 1) * 2.4, 1.6, 3.4)), target: c };
    }
  }
}
