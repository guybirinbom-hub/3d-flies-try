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
    const end = new THREE.Vector3(wellAt.x, 0, wellAt.y).add(start.clone().setY(0).normalize().multiplyScalar(1.9));
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

/** Stone well with a windlass under a little tiled roof on two posts. */
function well(b: PartBuilder, x: number, z: number, rng: Rng): void {
  const stones = 12;
  const ringR = 0.72;
  for (let ring = 0; ring < 3; ring++) {
    for (let i = 0; i < stones; i++) {
      const a = ((i + (ring % 2) * 0.5) / stones) * Math.PI * 2;
      const g = lumpify(new THREE.BoxGeometry(0.42, 0.22, 0.26, 2, 1, 1), 0.012, i * 7 + ring);
      b.add(g, 'stone', vary('#b9ad9a', rng, 0.07, 0.04), mat4(x + Math.cos(a) * ringR, 0.11 + ring * 0.23, z + Math.sin(a) * ringR, 0, -a + Math.PI / 2, 0));
    }
  }
  b.add(new THREE.CylinderGeometry(0.6, 0.6, 0.05, 20), 'glass', '#1d2b33', mat4(x, 0.55, z));
  // Posts stand outside the stone ring on their own footing stones.
  const postX = ringR + 0.13 + 0.08;
  const timber = vary('#5a4331', rng);
  for (const s of [-1, 1]) {
    b.box('stone', vary('#a99d8a', rng, 0.05), 0.24, 0.12, 0.24, mat4(x + s * postX, 0.06, z), 0.03);
    b.box('timber', timber, 0.12, 2.0, 0.12, mat4(x + s * postX, 1.1, z), 0.02);
  }
  b.box('timber', timber, 2 * postX + 0.2, 0.1, 0.1, mat4(x, 2.05, z), 0.02);
  for (const s of [-1, 1]) {
    b.box('roof', vary('#a65d3f', rng, 0.04), 2 * postX + 0.5, 0.06, 0.85, mat4(x, 2.32, z + s * 0.32, s * 0.65, 0, 0), 0.02);
  }
  // Windlass: axle between the posts with a crank, rope down to the bucket.
  const axleY = 1.45;
  b.add(new THREE.CylinderGeometry(0.06, 0.06, 2 * postX - 0.12, 10), 'wood', '#7b5636', mat4(x, axleY, z, 0, 0, Math.PI / 2));
  b.add(new THREE.CylinderGeometry(0.085, 0.085, 0.3, 12), 'wood', '#6d4c30', mat4(x, axleY, z, 0, 0, Math.PI / 2));
  b.box('metal', '#3b3735', 0.03, 0.22, 0.03, mat4(x + postX + 0.08, axleY - 0.1, z), 0.01);
  b.box('metal', '#3b3735', 0.14, 0.03, 0.03, mat4(x + postX + 0.14, axleY - 0.2, z), 0.01);
  b.add(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6), 'wood', '#c9b27c', mat4(x, axleY - 0.29, z + 0.07));
  b.add(new THREE.CylinderGeometry(0.12, 0.1, 0.18, 12), 'wood', '#7b5636', mat4(x, axleY - 0.59, z + 0.07));
  b.add(new THREE.TorusGeometry(0.11, 0.008, 4, 16), 'metal', '#3b3735', mat4(x, axleY - 0.52, z + 0.07, Math.PI / 2, 0, 0));
  // Gravel apron round the well where the lanes arrive.
  b.add(new THREE.CircleGeometry(2.1, 28).rotateX(-Math.PI / 2), 'stone', '#b9ab8f', mat4(x, 0.008, z), (p, _n, out) => {
    const k = Math.sin(p.x * 3.1) * Math.cos(p.z * 2.7) * 0.5 + 0.5;
    out.offsetHSL(0, -0.02, (k - 0.5) * 0.06);
  });
}

/** A soft gravel lane: one continuous ribbon (shared edges, no gaps at bends). */
function lane(b: PartBuilder, from: THREE.Vector3, to: THREE.Vector3, rng: Rng): void {
  const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(rng.jitter(2), 0, rng.jitter(2)));
  const pts = new THREE.QuadraticBezierCurve3(from, mid, to).getPoints(28);
  const width = rng.range(0.9, 1.2);
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  pts.forEach((p, i) => {
    // One side vector per point, averaged over the segments meeting there.
    const a = pts[Math.max(0, i - 1)];
    const c = pts[Math.min(pts.length - 1, i + 1)];
    const dir = c.clone().sub(a).setY(0).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width / 2);
    left.push(p.clone().add(side).setY(0.011));
    right.push(p.clone().sub(side).setY(0.011));
  });
  const positions: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    positions.push(...left[i].toArray(), ...left[i + 1].toArray(), ...right[i].toArray());
    positions.push(...right[i].toArray(), ...left[i + 1].toArray(), ...right[i + 1].toArray());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  // Normals must point up whatever the winding came out as.
  const n = g.attributes.normal as THREE.BufferAttribute;
  if (n.getY(0) < 0) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i += 3) {
      const t = [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)];
      pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
      pos.setXYZ(i + 2, t[0], t[1], t[2]);
    }
    g.computeVertexNormals();
  }
  b.add(g, 'stone', '#b9ab8f', undefined, (p, _n, out) => {
    const k = Math.sin(p.x * 3.1) * Math.cos(p.z * 2.7) * 0.5 + 0.5;
    out.offsetHSL(0, -0.02, (k - 0.5) * 0.06);
  });
}
