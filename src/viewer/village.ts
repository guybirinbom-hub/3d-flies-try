import * as THREE from 'three';
import { PartBuilder, lumpify, mat4, vary, type MatKey } from '../gen/builder';
import type { HouseLayout } from '../gen/layout';
import { Rng } from '../gen/rng';

/**
 * Placement of houses around a village green: each house faces the middle,
 * and neighbours are spaced by their actual widths so eaves never touch.
 */
export interface Placement {
  x: number;
  z: number;
  /** Rotation about Y (a house's front faces +Z before rotation). */
  rotY: number;
}

/** Half the footprint "width" a house needs along the ring (incl. roof overhang and props). */
function halfSpan(l: HouseLayout): number {
  return Math.max(l.bounds.max.x, -l.bounds.min.x) + 1.6;
}

export function placeAroundGreen(layouts: HouseLayout[], rng: Rng): Placement[] {
  const gap = 2.4;
  const circumference = layouts.reduce((s, l) => s + 2 * halfSpan(l) + gap, 0);
  const deepest = Math.max(...layouts.map((l) => l.bounds.max.z));
  // Big enough for everyone along the ring, and for a green with a well.
  const ring = Math.max(circumference / (Math.PI * 2), deepest + 8);
  const out: Placement[] = [];
  let arc = rng.range(0, 0.4);
  for (const l of layouts) {
    const half = halfSpan(l);
    arc += half / ring;
    const a = arc + rng.jitter(0.25 * (gap / 2) / ring);
    const r = ring + rng.jitter(1.2);
    // The house's +Z (front) must point at the centre: rotY = a + π.
    out.push({ x: Math.sin(a) * r, z: Math.cos(a) * r, rotY: a + Math.PI + rng.jitter(0.12) });
    arc += (half + gap) / ring;
  }
  return out;
}

/** World position of the outer end of a house's front path (≈ 4 m in front of the door). */
function doorFront(l: HouseLayout, p: Placement): THREE.Vector3 {
  const door = l.door;
  const wall = l.walls.find((w) => w.id === door.wallId)!;
  const local = new THREE.Vector3((door.u0 + door.u1) / 2, 0, 4.3).applyMatrix4(wall.frame);
  return local.applyAxisAngle(new THREE.Vector3(0, 1, 0), p.rotY).add(new THREE.Vector3(p.x, 0, p.z));
}

/**
 * Trees, a well on the green, and gravel lanes from every door to the
 * middle, built with the same vertex-colour style as the houses.
 */
export function villageDressing(
  layouts: HouseLayout[],
  places: Placement[],
  materials: Record<MatKey, THREE.Material>,
  seed: number,
): THREE.Group {
  const rng = new Rng(seed).fork('village-dressing');
  const group = new THREE.Group();
  group.name = 'village';
  const b = new PartBuilder('village');
  // The well sits in the middle of the green.
  const wellAt = new THREE.Vector2(0, 0);
  well(b, wellAt.x, wellAt.y, rng.fork('well'));

  // Lanes: gentle curves from each house's door to the well.
  places.forEach((p, i) => {
    const start = doorFront(layouts[i], p);
    const end = new THREE.Vector3(wellAt.x, 0, wellAt.y).add(start.clone().setY(0).normalize().multiplyScalar(1.4));
    lane(b, start, end, rng.fork(`lane${i}`));
  });

  // Trees: behind and between the houses, never on a lane or a house.
  const blockers = places.map((p, i) => ({ x: p.x, z: p.z, r: Math.hypot(layouts[i].bounds.max.x, layouts[i].bounds.max.z) + 1.2 }));
  blockers.push({ x: wellAt.x, z: wellAt.y, r: 3 });
  const outer = Math.max(...places.map((p) => Math.hypot(p.x, p.z))) + 9;
  let placed = 0;
  for (let tries = 0; tries < 400 && placed < 10 + places.length; tries++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(outer * 0.55, outer + 6);
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    if (blockers.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + 1.5)) continue;
    // Keep the view down each lane open.
    if (places.some((p) => {
      const dir = new THREE.Vector2(-p.x, -p.z).normalize();
      const rel = new THREE.Vector2(x - p.x, z - p.z);
      const along = rel.dot(dir);
      return along > 0 && along < Math.hypot(p.x, p.z) && Math.abs(rel.cross(dir)) < 3;
    })) continue;
    tree(b, x, z, rng.fork(`tree${tries}`));
    blockers.push({ x, z, r: 2.2 });
    placed++;
  }

  group.add(b.build(materials));
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.receiveShadow = true;
  });
  return group;
}

/** A round, lumpy deciduous tree. */
function tree(b: PartBuilder, x: number, z: number, rng: Rng): void {
  const h = rng.range(3.2, 5.5);
  const trunk = new THREE.CylinderGeometry(0.12, 0.2, h * 0.55, 7, 1);
  b.add(trunk, 'wood', vary('#5d4532', rng, 0.05), mat4(x, h * 0.275, z, rng.jitter(0.05), 0, rng.jitter(0.05)));
  const crownR = rng.range(1.2, 1.9);
  const green = rng.pick(['#5f8a3c', '#6b9443', '#557f38', '#78994a']);
  const blobs = rng.int(4, 6);
  for (let i = 0; i < blobs; i++) {
    const r = crownR * rng.range(0.55, 0.85);
    const a = (i / blobs) * Math.PI * 2 + rng.jitter(0.4);
    const off = i === 0 ? 0 : crownR * 0.5;
    const g = lumpify(new THREE.IcosahedronGeometry(r, 1), r * 0.08, rng.int(0, 999));
    b.add(g, 'foliage', vary(green, rng, 0.05, 0.05, 0.01), mat4(x + Math.cos(a) * off, h * 0.62 + crownR * 0.4 + (i === 0 ? crownR * 0.35 : rng.range(-0.2, 0.3)), z + Math.sin(a) * off));
  }
}

/** Stone well with a little tiled roof on two posts. */
function well(b: PartBuilder, x: number, z: number, rng: Rng): void {
  const stones = 12;
  for (let ring = 0; ring < 3; ring++) {
    for (let i = 0; i < stones; i++) {
      const a = ((i + (ring % 2) * 0.5) / stones) * Math.PI * 2;
      const g = lumpify(new THREE.BoxGeometry(0.42, 0.22, 0.26, 2, 1, 1), 0.012, i * 7 + ring);
      b.add(g, 'stone', vary('#b9ad9a', rng, 0.07, 0.04), mat4(x + Math.cos(a) * 0.72, 0.11 + ring * 0.23, z + Math.sin(a) * 0.72, 0, -a + Math.PI / 2, 0));
    }
  }
  b.add(new THREE.CylinderGeometry(0.62, 0.62, 0.05, 20), 'glass', '#1d2b33', mat4(x, 0.55, z));
  for (const s of [-1, 1]) b.box('timber', vary('#5a4331', rng), 0.12, 2.0, 0.12, mat4(x + s * 0.8, 1.0, z), 0.02);
  b.box('timber', '#5a4331', 1.8, 0.1, 0.1, mat4(x, 1.85, z), 0.02);
  for (const s of [-1, 1]) {
    b.box('roof', vary('#a65d3f', rng, 0.04), 2.1, 0.06, 0.85, mat4(x, 2.12, z + s * 0.32, s * 0.65, 0, 0), 0.02);
  }
  b.add(new THREE.CylinderGeometry(0.12, 0.1, 0.18, 10), 'wood', '#7b5636', mat4(x + 0.1, 1.3, z));
}

/** A soft gravel lane (flat ribbon just above the grass). */
function lane(b: PartBuilder, from: THREE.Vector3, to: THREE.Vector3, rng: Rng): void {
  const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(rng.jitter(2), 0, rng.jitter(2)));
  const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
  const pts = curve.getPoints(24);
  const positions: number[] = [];
  const width = rng.range(0.9, 1.2);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const c = pts[i + 1];
    const dir = c.clone().sub(a).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
    const y = 0.012;
    const p = [a.clone().add(side), a.clone().sub(side), c.clone().add(side), c.clone().sub(side)].map((v) => v.setY(y));
    positions.push(...p[0].toArray(), ...p[2].toArray(), ...p[1].toArray(), ...p[1].toArray(), ...p[2].toArray(), ...p[3].toArray());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  b.add(g, 'stone', '#b9ab8f', undefined, (p, _n, out) => {
    const k = Math.sin(p.x * 3.1) * Math.cos(p.z * 2.7) * 0.5 + 0.5;
    out.offsetHSL(0, -0.02, (k - 0.5) * 0.06);
  });
}
