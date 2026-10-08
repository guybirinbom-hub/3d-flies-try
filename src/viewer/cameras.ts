import * as THREE from 'three';
import type { HouseLayout } from '../gen/layout';
import { wallPoint } from '../gen/layout';
import { OUTWARD, roofLift } from '../gen/explode';

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

/**
 * Distance along `dir` (unit, from target to camera) at which every corner
 * of `box` projects inside `fill` of the frame (NDC), found by bisection.
 */
export function fitDistance(
  box: THREE.Box3,
  target: THREE.Vector3,
  dir: THREE.Vector3,
  fovDeg: number,
  aspect: number,
  fill = 0.86,
): number {
  const cam = new THREE.PerspectiveCamera(fovDeg, aspect, 0.05, 2000);
  const corners: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  const fits = (d: number) => {
    cam.position.copy(target).addScaledVector(dir, d);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    const v = new THREE.Vector3();
    return corners.every((c) => {
      v.copy(c).project(cam);
      return v.z < 1 && Math.abs(v.x) <= fill && Math.abs(v.y) <= fill;
    });
  };
  let lo = 0.5;
  let hi = 600;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Box to frame for a house, grown for the exploded view (layers move out
 * and the roof and chimney lift).
 */
export function framingBox(layout: HouseLayout, explode = 0): THREE.Box3 {
  const box = new THREE.Box3(layout.bounds.min.clone(), layout.bounds.max.clone());
  if (explode > 0) {
    box.max.y += explode * (roofLift(layout) + 1.6);
    box.expandByVector(new THREE.Vector3(OUTWARD.openings, 0, OUTWARD.openings).multiplyScalar(explode));
  }
  return box;
}

/** Position + target for a named viewpoint around a house. */
export function cameraFor(
  preset: CameraPreset,
  layout: HouseLayout,
  fovDeg: number,
  aspect: number,
  explode = 0,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const { max } = layout.bounds;
  const box = framingBox(layout, explode);
  const centre = box.getCenter(new THREE.Vector3());
  const target = new THREE.Vector3(centre.x, box.min.y + (box.max.y - box.min.y) * 0.45, centre.z);

  const from = (dx: number, dy: number, dz: number, fill = 0.95) => {
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    return target.clone().addScaledVector(dir, fitDistance(box, target, dir, fovDeg, aspect, fill));
  };

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
    case 'low': {
      const t = target.clone().setY(max.y * 0.4);
      const dir = new THREE.Vector3(0.7, 0.1, 1).normalize();
      return { position: t.clone().addScaledVector(dir, fitDistance(box, t, dir, fovDeg, aspect, 0.92)), target: t };
    }
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
