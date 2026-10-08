import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Rng } from './rng';

/**
 * Material slots. Every part paints its pieces with vertex colours and picks
 * one of these slots; the builder merges everything that shares a slot into
 * a single mesh, so a whole house is a few dozen draw calls.
 */
export type MatKey =
  | 'stone'
  | 'mortar'
  | 'plaster'
  | 'timber'
  | 'wood'
  | 'trim'
  | 'roof'
  | 'glass'
  | 'metal'
  | 'foliage'
  | 'flower'
  | 'glow';

export type ColorLike = THREE.ColorRepresentation;

/**
 * Collects geometry for one part of the house (e.g. "roof").
 * Geometry added here is copied, so callers can reuse templates.
 */
export class PartBuilder {
  private chunks = new Map<MatKey, THREE.BufferGeometry[]>();
  /** Extra exploded-view offset for this builder, added to its part's offset. */
  explode: [number, number, number] = [0, 0, 0];

  constructor(readonly name: string) {}

  /**
   * Add a geometry, transformed by `matrix` and painted `color` (or by
   * `paint(position, normal)` per vertex if given).
   */
  add(
    geom: THREE.BufferGeometry,
    mat: MatKey,
    color: ColorLike,
    matrix?: THREE.Matrix4,
    paint?: (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void,
  ): this {
    let g = geom.index ? geom.toNonIndexed() : geom.clone();
    for (const key of Object.keys(g.attributes)) {
      if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (matrix) g.applyMatrix4(matrix);
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    const c = new THREE.Color(color);
    if (paint) {
      const p = new THREE.Vector3();
      const nn = new THREE.Vector3();
      const pos = g.attributes.position;
      const nor = g.attributes.normal;
      for (let i = 0; i < n; i++) {
        p.fromBufferAttribute(pos, i);
        nn.fromBufferAttribute(nor, i);
        const out = c.clone();
        paint(p, nn, out);
        colors.set([out.r, out.g, out.b], i * 3);
      }
    } else {
      for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    let list = this.chunks.get(mat);
    if (!list) this.chunks.set(mat, (list = []));
    list.push(g);
    return this;
  }

  /**
   * Box of size (sx, sy, sz) centred on the origin of `matrix`.
   * `radius` > 0 gives rounded edges (clamped to half the smallest side).
   */
  box(
    mat: MatKey,
    color: ColorLike,
    sx: number,
    sy: number,
    sz: number,
    matrix?: THREE.Matrix4,
    radius = 0,
  ): this {
    return this.add(boxGeometry(sx, sy, sz, radius), mat, color, matrix);
  }

  /** Total triangles currently collected. */
  get triangles(): number {
    let n = 0;
    for (const list of this.chunks.values()) for (const g of list) n += g.attributes.position.count / 3;
    return n;
  }

  get isEmpty(): boolean {
    return this.chunks.size === 0;
  }

  /** Merge into one mesh per material. */
  build(materials: Record<MatKey, THREE.Material>): THREE.Group {
    const group = new THREE.Group();
    group.name = this.name;
    for (const [mat, list] of this.chunks) {
      const merged = mergeGeometries(list, false);
      if (!merged) throw new Error(`${this.name}: failed to merge ${mat} geometry`);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, materials[mat]);
      mesh.name = `${this.name}:${mat}`;
      mesh.castShadow = mat !== 'glass' && mat !== 'glow';
      mesh.receiveShadow = true;
      group.add(mesh);
      for (const g of list) g.dispose();
    }
    this.chunks.clear();
    return group;
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Box centred on the origin; rounded edges when radius > 0. */
export function boxGeometry(sx: number, sy: number, sz: number, radius = 0, segments = 2): THREE.BufferGeometry {
  const r = Math.min(radius, sx / 2 - 1e-4, sy / 2 - 1e-4, sz / 2 - 1e-4);
  if (r <= 0.002) return new THREE.BoxGeometry(sx, sy, sz);
  return new RoundedBoxGeometry(sx, sy, sz, segments, r);
}

/**
 * Displace every vertex (in place) by a pseudo-random offset that depends
 * only on its position, so coincident vertices stay welded. Gives stones and
 * tiles a hand-made, slightly lumpy look. Recomputes normals.
 */
export function lumpify(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = v.x * 12.9898 + v.y * 78.233 + v.z * 37.719 + seed * 0.618;
    pos.setXYZ(
      i,
      v.x + hashNoise(k) * amount,
      v.y + hashNoise(k + 17.17) * amount,
      v.z + hashNoise(k + 41.41) * amount,
    );
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function hashNoise(x: number): number {
  const s = Math.sin(x) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Matrix from position, Euler rotation (radians, XYZ) and optional scale. */
export function mat4(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** `a * b` without mutating either. */
export function mul(a: THREE.Matrix4, b: THREE.Matrix4): THREE.Matrix4 {
  return a.clone().multiply(b);
}

/**
 * A colour near `base`: hue/saturation/lightness jittered by the given
 * amounts (fractions, e.g. l = 0.08 → ±8 % lightness).
 */
export function vary(base: ColorLike, rng: Rng, l = 0.06, s = 0.04, h = 0.01): THREE.Color {
  const c = new THREE.Color(base);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(
    (hsl.h + rng.jitter(h) + 1) % 1,
    THREE.MathUtils.clamp(hsl.s + rng.jitter(s), 0, 1),
    THREE.MathUtils.clamp(hsl.l + rng.jitter(l), 0, 1),
  );
  return c;
}

/** Mix two colours (t = 0 → a, 1 → b). */
export function mix(a: ColorLike, b: ColorLike, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

/**
 * Extrude a 2D shape (in wall-local u/y) by `depth` towards -w (into the
 * wall), starting at w = `w0`. Returns geometry in wall-local coordinates.
 */
export function extrudeLocal(shape: THREE.Shape, depth: number, w0 = 0, curveSegments = 12): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
  // ExtrudeGeometry goes from z = 0 to z = depth; we want w0 → w0 - depth.
  g.translate(0, 0, w0 - depth);
  return g;
}
