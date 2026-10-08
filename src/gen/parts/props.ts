import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PartBuilder, boxGeometry, mat4, mix, mul, vary, type ColorLike, type MatKey } from '../builder';
import { OUTWARD, wallExplode } from '../explode';
import type { PartDef } from '../house';
import { roofUndersideY, wallMatrix, wallPoint, type HouseLayout, type Opening, type WallSpec } from '../layout';
import type { Palette } from '../params';
import type { Rng } from '../rng';

/**
 * Props: the life around the house. A path from the door steps, a lantern by
 * the door, a bench / barrels / woodpile against the walls, pots beside the
 * steps, shrubs and flowers along the base and grass tufts that blend the
 * house into the ground.
 *
 * Everything is placed on a small site plan (`Site`): every item claims an
 * oriented rectangle on the ground so nothing overlaps the house, the stoop,
 * the path or another item, and every ground-floor wall carries "zones"
 * (windows with their shutters and flower boxes, the doorway, the lantern)
 * that anything standing in front of the wall must stay below.
 */
export const part: PartDef = {
  name: 'props',
  label: 'Props',
  explode: [0, 0, 0],
  build: ({ layout, rng }) => {
    if (!layout.params.props) return new PartBuilder('props');
    const site = new Site(layout);
    // Order matters: earlier items claim their ground first. The path and the
    // lantern are the most important; plants and grass fill in around the rest.
    const builders = [
      buildPath(site, rng.fork('path')),
      buildLantern(site, rng.fork('lantern')),
      buildStoopPots(site, rng.fork('pots')),
      buildWoodpile(site, rng.fork('woodpile')),
      buildBench(site, rng.fork('bench')),
      buildBarrels(site, rng.fork('barrels')),
      ...buildPlanting(site, rng.fork('planting')),
    ];
    return builders.filter((b): b is PartBuilder => b !== null);
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The plinth band protrudes to w = +0.10; things standing against a wall keep their back here. */
const WALL_GAP = 0.13;
/** Outward reach of the plinth band around the ground storey. */
const PLINTH_REACH = 0.1;
/** How far below a window sill a flower box (with its trailing plants) may hang. */
const FLOWER_BOX_DROP = 0.42;
/** How far a grass tuft's leaning blades can reach from its root. */
const TUFT_REACH = 0.17;

/** Lanterns are modelled at a real-world size, then scaled up a little for the chunky style. */
const LANTERN_SCALE = 1.3;
const LANTERN_HEIGHT = 0.37 * LANTERN_SCALE;

const IRON = '#3d3834';
const GLOW = '#ffe0a3';
const DIRT = '#a8906c';
const GRAVEL = '#a99c86';
const GRASS_EDGE = '#93ab5f';
const GRASS_ROOT = '#587b39';
const GRASS_TIP = '#a9c56d';
const LEAVES = ['#55843d', '#659247', '#4d7a3a', '#76a04d', '#5f8a4a'];
const TERRACOTTA = '#c4704a';
const SOIL = '#5b4434';
const END_GRAIN = '#d9ba8c';
const SPLIT_WOOD = '#c39468';
const BARK = '#644935';
const WEATHERED = '#9c907f';

// ---------------------------------------------------------------------------
// Site plan: where things may go
// ---------------------------------------------------------------------------

/** Oriented rectangle on the ground plan: centre, unit long axis, half extents. */
interface Footprint {
  x: number;
  z: number;
  ax: number;
  az: number;
  /** Half length along the axis. */
  hl: number;
  /** Half width across it. */
  hw: number;
}

type ClaimKind = 'house' | 'stoop' | 'path' | 'solid' | 'plant';

/** Part of a wall face (u-range) that anything standing in front must stay below `yLow`. */
interface WallZone {
  u0: number;
  u1: number;
  yLow: number;
}

/** A spot found against a wall: u ∈ [u0, u1]. */
interface WallSpot {
  wall: WallSpec;
  u0: number;
  u1: number;
}

/** Centre-line sample of the path, in world plan coordinates. */
interface PathFrame {
  x: number;
  z: number;
  /** Unit tangent (walking away from the door). */
  tx: number;
  tz: number;
  /** Half width of the path here. */
  hw: number;
  /** Arc length from the stoop. */
  s: number;
}

/** Ground point at the foot of an item, where a grass tuft likes to grow. */
interface TuftAnchor {
  x: number;
  z: number;
  wall: WallSpec | null;
}

class Site {
  readonly walls: WallSpec[];
  readonly front: WallSpec;
  readonly palette: Palette;
  readonly anchors: TuftAnchor[] = [];
  path: PathFrame[] = [];
  private readonly zones = new Map<WallSpec, WallZone[]>();
  private readonly claims: { fp: Footprint; kind: ClaimKind }[] = [];

  constructor(readonly layout: HouseLayout) {
    const ground = layout.storeys[0];
    this.walls = ground.walls;
    this.palette = layout.params.palette;
    const front = this.walls.find((w) => w.id === layout.stoop.wallId);
    if (!front) throw new Error(`props: door wall ${layout.stoop.wallId} not found`);
    this.front = front;

    this.claim(
      {
        x: (ground.minX + ground.maxX) / 2,
        z: (ground.minZ + ground.maxZ) / 2,
        ax: 1,
        az: 0,
        hl: (ground.maxX - ground.minX) / 2 + PLINTH_REACH,
        hw: (ground.maxZ - ground.minZ) / 2 + PLINTH_REACH,
      },
      'house',
    );
    const { stoop } = layout;
    this.claim(this.wallFootprint(front, stoop.u0, stoop.u1, 0, stoop.w1), 'stoop');
    for (const wall of this.walls) this.zones.set(wall, wall.openings.map(openingZone));
  }

  addZone(wall: WallSpec, zone: WallZone): void {
    this.zones.get(wall)?.push(zone);
  }

  /** Height limit from the wall's zones for something in front of it over u ∈ [u0, u1]. */
  heightLimit(wall: WallSpec, u0: number, u1: number): number {
    let h = Infinity;
    for (const z of this.zones.get(wall) ?? []) if (u0 < z.u1 && u1 > z.u0) h = Math.min(h, z.yLow);
    return h;
  }

  /** Free u-intervals along `wall` (corner pad and tall-enough zones removed) for items of height h. */
  freeSpans(wall: WallSpec, h: number, pad = 0.15): [number, number][] {
    let spans: [number, number][] = [[pad, wall.length - pad]];
    for (const z of this.zones.get(wall) ?? []) {
      if (z.yLow >= h) continue;
      spans = spans.flatMap(([a, b]): [number, number][] => {
        if (z.u1 <= a || z.u0 >= b) return [[a, b]];
        const out: [number, number][] = [];
        if (z.u0 > a) out.push([a, z.u0]);
        if (z.u1 < b) out.push([z.u1, b]);
        return out;
      });
    }
    return spans.filter(([a, b]) => b > a);
  }

  /** Lowest overhead obstacle (roof eaves, jettied upper floors) above a ground point. */
  headroomAt(x: number, z: number): number {
    const { roof, storeys } = this.layout;
    let h = Infinity;
    const underRoofX = x > roof.minX - roof.overhangGable - 0.25 && x < roof.maxX + roof.overhangGable + 0.25;
    if (underRoofX && Math.abs(z) < roof.halfDepth + roof.overhangEave + 0.25) {
      // 0.3 m allowance for the fascia / tile edge hanging below the deck.
      h = roofUndersideY(roof, Math.abs(z)) - 0.3;
    }
    for (const s of storeys.slice(1)) {
      if (x > s.minX - 0.1 && x < s.maxX + 0.1 && Math.abs(z) < s.maxZ + 0.1) h = Math.min(h, s.y0 - 0.2);
    }
    return h;
  }

  headroom(fp: Footprint): number {
    const px = -fp.az;
    const pz = fp.ax;
    let h = this.headroomAt(fp.x, fp.z);
    for (const [a, c] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      h = Math.min(h, this.headroomAt(fp.x + fp.ax * fp.hl * a + px * fp.hw * c, fp.z + fp.az * fp.hl * a + pz * fp.hw * c));
    }
    return h;
  }

  /**
   * True when `fp` keeps `gap` from every claim (plants use `plantGap`, which
   * may be negative to let foliage overlap). The house itself only needs 0.
   */
  fits(fp: Footprint, gap = 0.03, plantGap = gap): boolean {
    return this.claims.every(
      (c) => !overlaps(fp, c.fp, c.kind === 'house' ? 0 : c.kind === 'plant' ? plantGap : gap),
    );
  }

  /**
   * Can a grass tuft grow at (x, z)? Its leaning blades must not reach the
   * steps; elsewhere only the root matters (a blade brushing a barrel or
   * leaning over the path edge is just what grass does). Plants don't count.
   */
  grassFits(x: number, z: number): boolean {
    return this.claims.every((c) => {
      if (c.kind === 'plant') return true;
      const r = c.kind === 'stoop' ? TUFT_REACH : 0.05;
      return !overlaps(circleFootprint(x, z, r), c.fp, 0);
    });
  }

  claim(fp: Footprint, kind: ClaimKind): void {
    this.claims.push({ fp, kind });
  }

  /** Footprint of the wall-local box u ∈ [u0, u1], w ∈ [w0, w1]. */
  wallFootprint(wall: WallSpec, u0: number, u1: number, w0: number, w1: number): Footprint {
    const c = wallPoint(wall, (u0 + u1) / 2, 0, (w0 + w1) / 2);
    return { x: c.x, z: c.z, ax: wall.dir.x, az: wall.dir.z, hl: (u1 - u0) / 2, hw: (w1 - w0) / 2 };
  }

  /** Footprint if an item of height h can stand in front of `wall` there (see `fits` for the gaps), else null. */
  standAgainst(wall: WallSpec, u0: number, u1: number, w0: number, w1: number, h: number, gap = 0.04, plantGap = gap): Footprint | null {
    if (this.heightLimit(wall, u0, u1) < h) return null;
    const fp = this.wallFootprint(wall, u0, u1, w0, w1);
    if (this.headroom(fp) < h || !this.fits(fp, gap, plantGap)) return null;
    return fp;
  }

  /**
   * Find a spot of length `len` against one of `walls` (in order of
   * preference) for an item reaching from w0 to w1 and up to height h.
   * With `hug`, items like to tuck against the end of a free stretch (next
   * to a window or a corner), as people tend to put things.
   */
  findWallSpot(rng: Rng, walls: WallSpec[], len: number, w0: number, w1: number, h: number, hug = false): WallSpot | null {
    for (const wall of walls) {
      const spans = this.freeSpans(wall, h).filter(([a, b]) => b - a >= len);
      for (let i = 0; i < 10 && spans.length; i++) {
        const [a, b] = rng.pick(spans);
        const slack = b - a - len;
        let u0 = a + rng.range(0, slack);
        if (hug && rng.chance(0.7)) {
          const nudge = rng.range(0, Math.min(0.12, slack));
          u0 = rng.chance(0.5) ? a + nudge : b - len - nudge;
        }
        const fp = this.standAgainst(wall, u0, u0 + len, w0, w1, h);
        if (fp) {
          this.claim(fp, 'solid');
          this.anchorFront(wall, u0, u0 + len, w1);
          return { wall, u0, u1: u0 + len };
        }
      }
    }
    return null;
  }

  /** Outward normal of the ground-floor wall that (x, z) stands in front of, within `reach`. */
  wallNormalNear(x: number, z: number, reach = 0.6): { x: number; z: number } | null {
    for (const wall of this.walls) {
      const dx = x - wall.start.x;
      const dz = z - wall.start.z;
      const u = dx * wall.dir.x + dz * wall.dir.z;
      const w = dx * wall.normal.x + dz * wall.normal.z;
      if (w > -0.05 && w < reach && u > -0.3 && u < wall.length + 0.3) return wall.normal;
    }
    return null;
  }

  /** Remember the front corners of a wall item as places for grass tufts. */
  anchorFront(wall: WallSpec, u0: number, u1: number, w: number): void {
    for (const u of [u0 - 0.1, u1 + 0.1]) {
      const p = wallPoint(wall, u, 0, w + 0.1);
      this.anchors.push({ x: p.x, z: p.z, wall });
    }
  }
}

/** The part of a wall face around an opening that props must keep below. */
function openingZone(o: Opening): WallZone {
  if (o.kind === 'door') {
    // Nothing stands in front of the doorway or under its canopy.
    return { u0: o.lintel.u0 - 0.15, u1: o.lintel.u1 + 0.15, yLow: -Infinity };
  }
  // Open shutters reach about half the window width beyond each side.
  const shutter = o.shutters ? (o.u1 - o.u0) / 2 + 0.06 : 0;
  return {
    u0: Math.min(o.surround.u0, o.u0 - shutter) - 0.04,
    u1: Math.max(o.surround.u1, o.u1 + shutter) + 0.04,
    yLow: o.flowerBox && o.sill ? o.sill.y0 - FLOWER_BOX_DROP : o.surround.y0 - 0.05,
  };
}

/** Separating-axis test for two footprints, inflated by `gap`. */
function overlaps(a: Footprint, b: Footprint, gap: number): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const axes = [
    [a.ax, a.az],
    [-a.az, a.ax],
    [b.ax, b.az],
    [-b.az, b.ax],
  ];
  for (const [nx, nz] of axes) {
    const ra = a.hl * Math.abs(a.ax * nx + a.az * nz) + a.hw * Math.abs(-a.az * nx + a.ax * nz);
    const rb = b.hl * Math.abs(b.ax * nx + b.az * nz) + b.hw * Math.abs(-b.az * nx + b.ax * nz);
    if (Math.abs(dx * nx + dz * nz) >= ra + rb + gap) return false;
  }
  return true;
}

function circleFootprint(x: number, z: number, r: number): Footprint {
  return { x, z, ax: 1, az: 0, hl: r, hw: r };
}

/** Exploded-view offset pushing a free-standing group away from the house centre. */
function radialExplode(x: number, z: number): [number, number, number] {
  const d = Math.hypot(x, z) || 1;
  return [(x / d) * OUTWARD.props, 0, (z / d) * OUTWARD.props];
}

/**
 * Matrix for a ground object at plan (x, z) whose local +Z follows the
 * tangent (tx, tz) and local +X points to the left of it.
 */
function planMatrix(x: number, z: number, tx: number, tz: number, y = 0): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(tz, 0, -tx), new THREE.Vector3(0, 1, 0), new THREE.Vector3(tx, 0, tz))
    .setPosition(x, y, z);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Box with a single-segment rounded edge (108 triangles instead of the 300 of
 * `PartBuilder.box`): plenty for props this small. radius 0 → plain box.
 */
function rbox(b: PartBuilder, mat: MatKey, color: ColorLike, sx: number, sy: number, sz: number, m: THREE.Matrix4, radius = 0): void {
  b.add(boxGeometry(sx, sy, sz, radius, 1), mat, color, m);
}

interface Vertex {
  p: THREE.Vector3;
  c: THREE.Color;
}

/**
 * Flat-shaded triangles that each carry their own vertex colours, added to a
 * builder as one geometry (used for the path ribbon and the woodpile, where
 * every log face has its own colour).
 */
class TriSoup {
  private readonly pos: number[] = [];
  private readonly cols: THREE.Color[] = [];

  tri(a: Vertex, b: Vertex, c: Vertex): void {
    for (const v of [a, b, c]) {
      this.pos.push(v.p.x, v.p.y, v.p.z);
      this.cols.push(v.c);
    }
  }

  /** Like `tri`, but wound so the face points up. */
  triUp(a: Vertex, b: Vertex, c: Vertex): void {
    const ny = (b.p.z - a.p.z) * (c.p.x - a.p.x) - (b.p.x - a.p.x) * (c.p.z - a.p.z);
    if (ny >= 0) this.tri(a, b, c);
    else this.tri(a, c, b);
  }

  /** Quad a-b-c-d (counter-clockwise seen from the front) in one colour. */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color): void {
    this.tri({ p: a, c: color }, { p: b, c: color }, { p: c, c: color });
    this.tri({ p: a, c: color }, { p: c, c: color }, { p: d, c: color });
  }

  addTo(builder: PartBuilder, mat: MatKey, matrix?: THREE.Matrix4): void {
    if (!this.pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    // PartBuilder.add paints the vertices of a non-indexed geometry in order,
    // so a running counter hands each vertex its own colour.
    const cols = this.cols;
    let i = 0;
    builder.add(g, mat, '#ffffff', matrix, (_p, _n, out) => {
      out.copy(cols[Math.min(i++, cols.length - 1)]);
    });
  }
}

/** Surface radius (≈ 1 ± 0.15) of foliage blob `variant` in unit direction d. */
function blobRadius(d: THREE.Vector3, variant: number): number {
  const p = variant * 2.17;
  return (
    1 +
    0.08 * Math.sin(2.6 * d.x + p) * Math.cos(2.2 * d.z + p * 1.3) +
    0.05 * Math.sin(3.7 * d.y + 3.1 * d.x + p * 0.7) +
    0.03 * Math.sin(5.3 * d.z - 4.1 * d.y + p * 1.9)
  );
}

const BLOB_VARIANTS = 8;
/** Largest radius factor `blobRadius` can return: blobs bulge this far past their nominal radii. */
const BLOB_BULGE = 1.16;
/** Room left around foliage for the flowers sitting on its surface. */
const FLOWER_MARGIN = 0.035;
const blobCache = new Map<string, THREE.BufferGeometry>();

/** A soft, lumpy unit sphere with smooth normals (cached per detail/variant). */
function blobGeometry(detail: number, variant: number): THREE.BufferGeometry {
  const key = `${detail}:${variant}`;
  let g = blobCache.get(key);
  if (!g) {
    let base: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
    base.deleteAttribute('normal');
    base.deleteAttribute('uv');
    base = mergeVertices(base);
    const pos = base.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      v.multiplyScalar(blobRadius(v, variant));
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    base.computeVertexNormals();
    blobCache.set(key, (g = base));
  }
  return g;
}

/** Weld a geometry's vertices and give it smooth normals. */
function smoothed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const merged = mergeVertices(g);
  merged.computeVertexNormals();
  return merged;
}

/** Paint that darkens foliage towards the ground: cheap volume and contact shadow. */
function foliagePaint(height: number) {
  return (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => {
    const t = THREE.MathUtils.clamp(p.y / Math.max(height, 0.05), 0, 1);
    out.multiplyScalar(0.6 + 0.42 * t + 0.1 * Math.max(0, n.y));
  };
}

/**
 * A flat stone with a pillowy rounded edge, its foot sunk into the ground.
 * `outline` is a star-shaped polygon around the origin, as (x, z) points in
 * order of increasing angle from +x towards +z.
 */
function slabGeometry(outline: THREE.Vector2[], top: number, bevel: number): THREE.BufferGeometry {
  const n = outline.length;
  const avgR = outline.reduce((s, p) => s + p.length(), 0) / n;
  const inner = Math.max(0.3, 1 - bevel / avgR);
  const pos: number[] = [0, top, 0];
  const ring = (k: number, y: number) => {
    for (const p of outline) pos.push(p.x * k, y, p.y * k);
  };
  ring(inner * 0.55, top); // flat top
  ring(inner, top - bevel * 0.12); // start of the rounded edge
  ring(1, top - bevel * 0.75); // shoulder
  ring(1.05, -0.03); // foot, below ground
  const at = (r: number, i: number) => 1 + r * n + (i % n);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(0, at(0, i + 1), at(0, i));
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < n; i++) {
      const a = at(r, i);
      const b = at(r, i + 1);
      const c = at(r + 1, i + 1);
      const d = at(r + 1, i);
      idx.push(a, c, d, a, b, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Irregular roundish outline with radii (rx, rz): a couple of broad lobes
 * plus a little per-point chipping, so stones never read as polygons.
 */
function stoneOutline(rng: Rng, rx: number, rz: number): THREE.Vector2[] {
  const n = rng.int(11, 14);
  const lobes = rng.int(2, 3);
  const phase = rng.range(0, Math.PI * 2);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + rng.jitter(0.25)) / n) * Math.PI * 2;
    const k = 0.95 + 0.07 * Math.sin(a * lobes + phase) + rng.jitter(0.035);
    pts.push(new THREE.Vector2(Math.cos(a) * rx * k, Math.sin(a) * rz * k));
  }
  return pts;
}

/**
 * Five-petal-ish flower: a rim of radius 1 at y = 0.2 around a slightly sunken
 * centre, tapering to a narrow base at y = -0.2. 3n triangles.
 */
function flowerCupGeometry(n: number): THREE.BufferGeometry {
  const pos: number[] = [0, 0.12, 0];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.push(Math.cos(a), 0.2, Math.sin(a));
  }
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    pos.push(Math.cos(a) * 0.35, -0.2, Math.sin(a) * 0.35);
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const r0 = 1 + i;
    const r1 = 1 + ((i + 1) % n);
    const b0 = 1 + n + i;
    idx.push(0, r1, r0, r0, r1, b0);
  }
  for (let i = 0; i < n; i++) {
    const b0 = 1 + n + i;
    const b1 = 1 + n + ((i + 1) % n);
    idx.push(1 + ((i + 1) % n), b1, b0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Field-stone colour, sometimes a little mossy. */
function stoneColor(rng: Rng, base: ColorLike): THREE.Color {
  const c = vary(base, rng, 0.07, 0.05, 0.015);
  return rng.chance(0.3) ? c.lerp(new THREE.Color('#7f9257'), rng.range(0.08, 0.25)) : c;
}

/** Flower colours from the palette, softened so pure white never appears. */
function flowerColors(pal: Palette): THREE.Color[] {
  return pal.flowers.map((f) => mix(f, '#efe7d6', 0.12));
}

const GRASS_BLADE = new THREE.ConeGeometry(1, 1, 3, 1, true).translate(0, 0.5, 0);
const FLOWER_HEAD = new THREE.OctahedronGeometry(1, 0);
const UP = new THREE.Vector3(0, 1, 0);
/** Small rounded lump (20 triangles, smooth normals): pebbles, leaves, buds. */
const PEBBLE = smoothed(new THREE.IcosahedronGeometry(1, 0));
/** Open flower facing +y: a shallow five-sided cup, radius 1 (no bottom, it sits in foliage). */
const FLOWER_CUP = flowerCupGeometry(5);
const HOLLYHOCK_STEM = new THREE.CylinderGeometry(0.011, 0.017, 1, 5, 1, true).translate(0, 0.5, 0);

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

type PathStyle = 'stepping' | 'trail' | 'flagstone';

/** A gently curving path from the outer edge of the stoop out into the garden. */
function buildPath(site: Site, rng: Rng): PartBuilder {
  const b = new PartBuilder('props:path');
  const style = rng.weighted<PathStyle>([
    ['stepping', 3],
    ['trail', 4],
    ['flagstone', 3],
  ]);
  // 3–5 m out from the steps, but never wandering more than ~4 m past the
  // house's own bounds (high plinths make long stoops).
  const { stoop, bounds } = site.layout;
  const startOut = wallPoint(site.front, (stoop.u0 + stoop.u1) / 2, 0, stoop.w1).z;
  const length = Math.max(2.4, Math.min(rng.range(3.2, 5), bounds.max.z + 4.1 - startOut));
  const bend = (rng.chance(0.5) ? -1 : 1) * rng.range(0.3, 1.3);
  const halfWidth = style === 'stepping' ? 0.3 : style === 'trail' ? rng.range(0.36, 0.46) : rng.range(0.44, 0.54);
  const frames = pathFrames(site, length, bend, halfWidth, rng);
  site.path = frames;
  for (let i = 0; i < frames.length - 1; i++) site.claim(segmentFootprint(frames[i], frames[i + 1], 0.05), 'path');

  const stone = site.palette.stone;
  if (style === 'stepping') {
    addSteppingStones(b, rng, frames, { first: 0.3, spacing: [0.55, 0.65], size: [0.22, 0.28], lateral: 0.06, stone });
  } else if (style === 'trail') {
    addPathRibbon(b, rng, frames, new THREE.Color(DIRT));
    addSteppingStones(b, rng, frames, { first: 0.3, spacing: [0.65, 0.95], size: [0.18, 0.24], lateral: 0.12, stone });
    addPebbles(b, rng, frames, stone);
  } else {
    addPathRibbon(b, rng, frames, mix(GRAVEL, stone, 0.3));
    addFlagstones(b, rng, frames, stone);
  }
  addPathGrass(b, rng, site, frames);

  const mid = frames[Math.floor(frames.length / 2)];
  b.explode = radialExplode(mid.x, mid.z);
  return b;
}

/** Samples along a cubic curve that leaves the stoop straight and bends sideways. */
function pathFrames(site: Site, length: number, bend: number, halfWidth: number, rng: Rng): PathFrame[] {
  const wall = site.front;
  const { stoop } = site.layout;
  const origin = wallPoint(wall, (stoop.u0 + stoop.u1) / 2, 0, stoop.w1);
  // Curve in "door space": x = sideways along the wall, y = outward from the stoop edge.
  const curve = new THREE.CubicBezierCurve(
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0, length * 0.4),
    new THREE.Vector2(bend * 0.75, length * 0.62),
    new THREE.Vector2(bend, length),
  );
  const arc = curve.getLength();
  const n = Math.max(8, Math.ceil(arc / 0.14));
  const phase = rng.range(0, 10);
  const frames: PathFrame[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const p = curve.getPointAt(s);
    const t = curve.getTangentAt(s);
    const flare = 1 + 0.28 * (1 - smoothstep(0, 0.18, s)); // wider where it meets the steps
    const taper = 1 - 0.45 * smoothstep(0.72, 1, s); // and fading out at the far end
    const wobble = 1 + 0.06 * Math.sin(s * 9 + phase);
    frames.push({
      x: origin.x + wall.dir.x * p.x + wall.normal.x * p.y,
      z: origin.z + wall.dir.z * p.x + wall.normal.z * p.y,
      tx: wall.dir.x * t.x + wall.normal.x * t.y,
      tz: wall.dir.z * t.x + wall.normal.z * t.y,
      hw: halfWidth * flare * taper * wobble,
      s: s * arc,
    });
  }
  return frames;
}

/** Path frame interpolated at arc length s. */
function frameAt(frames: PathFrame[], s: number): PathFrame {
  const last = frames[frames.length - 1];
  if (s >= last.s) return last;
  let i = 0;
  while (i < frames.length - 2 && frames[i + 1].s < s) i++;
  const a = frames[i];
  const b = frames[i + 1];
  const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
  const tx = THREE.MathUtils.lerp(a.tx, b.tx, t);
  const tz = THREE.MathUtils.lerp(a.tz, b.tz, t);
  const tl = Math.hypot(tx, tz) || 1;
  return {
    x: THREE.MathUtils.lerp(a.x, b.x, t),
    z: THREE.MathUtils.lerp(a.z, b.z, t),
    tx: tx / tl,
    tz: tz / tl,
    hw: THREE.MathUtils.lerp(a.hw, b.hw, t),
    s,
  };
}

/** Point `lat` metres to the left of the path centre at frame f. */
function beside(f: PathFrame, lat: number): { x: number; z: number } {
  return { x: f.x + f.tz * lat, z: f.z - f.tx * lat };
}

function segmentFootprint(a: PathFrame, b: PathFrame, pad: number): Footprint {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1e-3;
  return {
    x: (a.x + b.x) / 2,
    z: (a.z + b.z) / 2,
    ax: dx / len,
    az: dz / len,
    hl: len / 2 + 0.02,
    hw: Math.max(a.hw, b.hw) + pad,
  };
}

/** Worn earth / gravel ribbon whose edges melt into the grass. */
function addPathRibbon(b: PartBuilder, rng: Rng, frames: PathFrame[], base: THREE.Color): void {
  const soup = new TriSoup();
  const lanes = [-1, -0.55, 0, 0.55, 1];
  const grass = new THREE.Color(GRASS_EDGE);
  const phL = rng.range(0, 10);
  const phR = rng.range(0, 10);
  const rows: Vertex[][] = frames.map((f, i) => {
    const edgeL = 1 + 0.09 * Math.sin(i * 0.8 + phL) + rng.jitter(0.05);
    const edgeR = 1 + 0.09 * Math.sin(i * 0.7 + phR) + rng.jitter(0.05);
    const fade = smoothstep(0.78, 1, i / (frames.length - 1));
    return lanes.map((k) => {
      const edge = Math.abs(k) === 1;
      const lat = k * f.hw * (edge ? (k > 0 ? edgeL : edgeR) : 1);
      const p = beside(f, lat);
      const c = vary(base, rng, 0.035, 0.03, 0.005);
      if (k === 0) c.multiplyScalar(0.95); // the worn centre track
      c.lerp(grass, Math.min(1, (edge ? 0.85 : Math.abs(k) > 0 ? 0.12 : 0) + fade * 0.9));
      return { p: new THREE.Vector3(p.x, edge ? 0.004 : 0.008, p.z), c };
    });
  });
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < lanes.length - 1; j++) {
      const a = rows[i][j];
      const bb = rows[i][j + 1];
      const c = rows[i + 1][j + 1];
      const d = rows[i + 1][j];
      soup.triUp(a, bb, c);
      soup.triUp(a, c, d);
    }
  }
  soup.addTo(b, 'mortar');
}

interface SteppingOpts {
  first: number;
  spacing: [number, number];
  size: [number, number];
  lateral: number;
  stone: string;
}

/** Single file of flat stones, one per stride, alternating a little left and right. */
function addSteppingStones(b: PartBuilder, rng: Rng, frames: PathFrame[], o: SteppingOpts): void {
  const total = frames[frames.length - 1].s;
  let side = rng.chance(0.5) ? 1 : -1;
  for (let d = o.first; d < total - 0.15; d += rng.range(o.spacing[0], o.spacing[1])) {
    const rx = rng.range(o.size[0], o.size[1]) * (1 - 0.25 * smoothstep(0.75, 1, d / total));
    const rz = rx * rng.range(0.72, 0.9);
    // However it is turned, the stone (outline up to 1.08 × rx, foot 5 % wider) stays off the steps.
    d = Math.max(d, rx * 1.15 + 0.04);
    const f = frameAt(frames, d);
    const lat = THREE.MathUtils.clamp(side * o.lateral + rng.jitter(o.lateral * 0.6), -f.hw + rx * 0.8, f.hw - rx * 0.8);
    side = -side;
    const p = beside(f, lat);
    const m = mul(planMatrix(p.x, p.z, f.tx, f.tz), mat4(0, 0, 0, 0, rng.jitter(0.35), 0));
    b.add(slabGeometry(stoneOutline(rng, rx, rz), rng.range(0.026, 0.04), 0.03), 'stone', stoneColor(rng, o.stone), m);
  }
}

/** Rows of irregular flagstones (1–3 per row) laid edge to edge across the path. */
function addFlagstones(b: PartBuilder, rng: Rng, frames: PathFrame[], stone: string): void {
  const total = frames[frames.length - 1].s;
  const gap = 0.022;
  let d = 0.07; // first row a hand's width off the bottom step
  while (d < total - 0.2) {
    const depth = rng.range(0.3, 0.42);
    const f = frameAt(frames, d + depth / 2);
    const hw = f.hw * 0.9;
    const fadeOut = smoothstep(0.65, 1, d / total);
    const cells = hw * 2 > 0.95 ? rng.int(2, 3) : hw * 2 > 0.55 ? rng.int(1, 2) : 1;
    // Random cut positions across the path.
    const cuts = [-hw];
    for (let k = 1; k < cells; k++) cuts.push(-hw + ((2 * hw) / cells) * (k + rng.jitter(0.25)));
    cuts.push(hw);
    for (let k = 0; k < cells; k++) {
      if (rng.chance(fadeOut * 0.55)) continue;
      const cw = (cuts[k + 1] - cuts[k]) / 2 - gap;
      const cd = depth / 2 - gap;
      if (cw < 0.08) continue;
      const lat = (cuts[k] + cuts[k + 1]) / 2 + rng.jitter(0.015);
      const p = beside(f, lat);
      const m = mul(planMatrix(p.x, p.z, f.tx, f.tz), mat4(0, 0, rng.jitter(0.02), 0, rng.jitter(0.06), 0));
      b.add(slabGeometry(cellOutline(rng, cw, cd), rng.range(0.022, 0.034), 0.026), 'stone', stoneColor(rng, stone), m);
    }
    d += depth;
  }
}

/** Roughly rectangular stone outline (half sizes hx, hz) with knocked-off corners. */
function cellOutline(rng: Rng, hx: number, hz: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const corners = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  // Ordered by increasing angle from +x towards +z.
  for (const [sx, sz] of corners) {
    const corner = sx !== 0 && sz !== 0;
    const k = corner ? rng.range(0.8, 0.93) : rng.range(0.94, 1.04);
    pts.push(new THREE.Vector2(sx * hx * k + rng.jitter(0.012), sz * hz * k + rng.jitter(0.012)));
  }
  return pts;
}

/** Little pebbles scattered along the edges of a trail. */
function addPebbles(b: PartBuilder, rng: Rng, frames: PathFrame[], stone: string): void {
  const dirt = new THREE.Color(DIRT);
  for (const f of frames) {
    if (f.s < 0.08) continue; // keep clear of the bottom step
    for (const side of [-1, 1]) {
      if (!rng.chance(0.45)) continue;
      const p = beside(f, side * f.hw * rng.range(0.75, 1.08));
      const r = rng.range(0.025, 0.05);
      const m = mat4(p.x, 0.004, p.z, rng.jitter(0.3), rng.range(0, 6), rng.jitter(0.3), r, r * rng.range(0.45, 0.7), r * rng.range(0.7, 1));
      b.add(PEBBLE, 'stone', stoneColor(rng, stone).lerp(dirt, 0.3), m);
    }
  }
}

/** Grass tufts along both edges of the path and at the corners of the steps. */
function addPathGrass(b: PartBuilder, rng: Rng, site: Site, frames: PathFrame[]): void {
  for (let i = 1; i < frames.length; i += 2) {
    const f = frames[i];
    for (const side of [-1, 1]) {
      if (!rng.chance(0.55)) continue;
      const p = beside(f, side * (f.hw + rng.range(0.06, 0.3)));
      if (site.grassFits(p.x, p.z)) addTuft(b, rng, p.x, p.z, rng.range(0.8, 1.15), site.wallNormalNear(p.x, p.z));
    }
  }
  const { stoop } = site.layout;
  for (const u of [stoop.u0 - 0.14, stoop.u1 + 0.14]) {
    const p = wallPoint(site.front, u, 0, stoop.w1 + rng.range(-0.05, 0.08));
    // Upright-ish so no blade leans into the steps.
    if (site.grassFits(p.x, p.z)) addTuft(b, rng, p.x, p.z, rng.range(0.9, 1.2), site.front.normal, 0.25);
  }
}

// ---------------------------------------------------------------------------
// Lantern
// ---------------------------------------------------------------------------

/**
 * A wrought-iron wall lantern beside the door. If both sides of the door are
 * taken by windows / shutters (or the eave comes down too low), it stands on
 * a wooden post beside the path instead.
 */
function buildLantern(site: Site, rng: Rng): PartBuilder | null {
  const b = new PartBuilder('props:lantern');
  const wall = site.front;
  const door = site.layout.door;
  const dc = (door.u0 + door.u1) / 2;
  const reach = 0.32; // w of the lantern's axis
  // Arm level with the door head; lower when an eave or jetty comes down close.
  const below = wallPoint(wall, dc, 0, reach + 0.12);
  const head = site.headroomAt(below.x, below.z);
  const armY = Math.min(door.y1 - 0.02, wall.y1 - 0.22, head - 0.05);
  const fitsWall = armY - LANTERN_HEIGHT > door.y0 + 1.0;

  if (fitsWall) {
    const sides = rng.chance(0.5) ? [1, -1] : [-1, 1];
    for (const side of sides) {
      const lu = dc + side * ((door.u1 - door.u0) / 2 + 0.5);
      if (!lanternClear(wall, lu, armY)) continue;
      addWallBracket(b, rng, wallMatrix(wall, lu, armY, 0), reach);
      addLantern(b, rng, wallMatrix(wall, lu, armY - 0.012, reach));
      site.addZone(wall, { u0: lu - 0.2, u1: lu + 0.2, yLow: armY - LANTERN_HEIGHT - 0.1 });
      b.explode = wallExplode(wall, OUTWARD.props);
      return b;
    }
  }
  return buildLanternPost(site, rng, b);
}

/** True when a wall lantern at u = lu (arm at armY) stays clear of the wall's openings. */
function lanternClear(wall: WallSpec, lu: number, armY: number): boolean {
  const r = { u0: lu - 0.17, u1: lu + 0.17, y0: armY - LANTERN_HEIGHT - 0.04, y1: armY + 0.08 };
  if (r.u0 < 0.3 || r.u1 > wall.length - 0.3) return false;
  return wall.openings.every((o) => {
    if (o.kind === 'door') {
      // The canopy spans the lintel ± 0.15.
      return r.u0 >= o.lintel.u1 + 0.15 || r.u1 <= o.lintel.u0 - 0.15;
    }
    const shutter = o.shutters ? (o.u1 - o.u0) / 2 + 0.05 : 0;
    const u0 = Math.min(o.surround.u0, o.u0 - shutter) - 0.04;
    const u1 = Math.max(o.surround.u1, o.u1 + shutter) + 0.04;
    const y0 = (o.flowerBox && o.sill ? o.sill.y0 - 0.35 : o.surround.y0) - 0.04;
    const y1 = o.surround.y1 + 0.04;
    return r.u1 <= u0 || r.u0 >= u1 || r.y1 <= y0 || r.y0 >= y1;
  });
}

/**
 * Wrought-iron bracket on the wall: back plate, horizontal arm and a curly
 * brace. `m` is the wall frame at the arm's root (w = 0, arm height).
 */
function addWallBracket(b: PartBuilder, rng: Rng, m: THREE.Matrix4, reach: number): void {
  const iron = vary(IRON, rng, 0.03, 0.02, 0);
  const at = (u: number, y: number, w: number, rx = 0, ry = 0, rz = 0) => mul(m, mat4(u, y, w, rx, ry, rz));
  const armLen = reach + 0.05 - 0.1;
  rbox(b, 'metal', iron, 0.075, 0.3, 0.02, at(0, -0.11, 0.09), 0.006); // back plate, w ∈ [0.08, 0.10]
  rbox(b, 'metal', iron, 0.024, 0.024, armLen, at(0, 0, 0.1 + armLen / 2), 0.006);
  // Diagonal brace from the bottom of the plate up to the arm.
  const by0 = -0.22;
  const bw1 = 0.1 + armLen * 0.62;
  const braceLen = Math.hypot(-by0, bw1 - 0.1);
  rbox(b, 'metal', iron, 0.018, 0.018, braceLen, at(0, by0 / 2, (0.1 + bw1) / 2, Math.atan2(-by0, bw1 - 0.1), 0, 0), 0.005);
  // Scroll in the corner between arm and brace.
  const scroll = new THREE.TorusGeometry(0.04, 0.006, 4, 12, Math.PI * 1.4);
  b.add(scroll, 'metal', iron, at(0, -0.05, 0.155, 0, Math.PI / 2, 0.3));
  b.add(new THREE.IcosahedronGeometry(0.017, 1), 'metal', iron, at(0, 0, 0.1 + armLen + 0.008));
  // Two rivets on the plate.
  for (const y of [-0.01, -0.21]) b.add(new THREE.IcosahedronGeometry(0.009, 0), 'metal', iron, at(0, y, 0.102));
}

/**
 * Square lantern hanging below the origin of `m` (glowing glass, iron frame,
 * little roof); LANTERN_HEIGHT tall and about 0.22 m across.
 */
function addLantern(b: PartBuilder, rng: Rng, m: THREE.Matrix4): void {
  const iron = vary(IRON, rng, 0.03, 0.02, 0);
  const k = LANTERN_SCALE;
  const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => mul(m, mat4(x * k, y * k, z * k, rx, ry, rz, k, k, k));
  b.add(new THREE.TorusGeometry(0.02, 0.005, 4, 10), 'metal', iron, at(0, -0.018, 0)); // hanging ring
  b.add(new THREE.IcosahedronGeometry(0.016, 1), 'metal', iron, at(0, -0.045, 0)); // finial
  b.add(new THREE.ConeGeometry(0.12, 0.085, 4, 1), 'metal', iron, at(0, -0.095, 0, 0, Math.PI / 4, 0)); // roof
  rbox(b, 'metal', iron, 0.17, 0.016, 0.17, at(0, -0.142, 0)); // eave of the little roof
  rbox(b, 'glow', GLOW, 0.115, 0.15, 0.115, at(0, -0.225, 0));
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    rbox(b, 'metal', iron, 0.016, 0.168, 0.016, at(sx * 0.058, -0.225, sz * 0.058));
  }
  rbox(b, 'metal', iron, 0.15, 0.022, 0.15, at(0, -0.31, 0), 0.006); // base
  b.add(new THREE.ConeGeometry(0.03, 0.045, 6), 'metal', iron, at(0, -0.343, 0, Math.PI, 0, 0)); // drip finial
}

/** Fallback: a wooden lantern post beside the path, a stride out from the steps. */
function buildLanternPost(site: Site, rng: Rng, b: PartBuilder): PartBuilder | null {
  const frames = site.path;
  if (!frames.length) return null;
  const sides = rng.chance(0.5) ? [1, -1] : [-1, 1];
  for (const d of [0.7, 1.1, 0.4, 1.6]) {
    for (const side of sides) {
      const f = frameAt(frames, d);
      const lat = side * (f.hw + 0.32);
      const p = beside(f, lat);
      // Post plus arm: the arm runs alongside the path, away from the house,
      // so the lantern hangs beside the path and never over it or the steps.
      const fp: Footprint = { x: p.x + f.tx * 0.2, z: p.z + f.tz * 0.2, ax: f.tx, az: f.tz, hl: 0.32, hw: 0.12 };
      const height = 1.75;
      if (!site.fits(fp, 0.05) || site.headroom(circleFootprint(p.x, p.z, 0.45)) < height + 0.1) continue;
      site.claim(fp, 'solid');
      site.anchors.push({ x: p.x, z: p.z, wall: null });
      // Local +X follows the path tangent.
      const m = planMatrix(p.x, p.z, -f.tz, f.tx);
      const wood = vary(site.palette.timber, rng, 0.04, 0.03, 0.01);
      const at = (x: number, y: number, z: number, rz = 0) => mul(m, mat4(x, y, z, 0, 0, rz));
      rbox(b, 'timber', wood, 0.11, height + 0.05, 0.11, at(0, (height - 0.05) / 2, 0), 0.02);
      b.add(new THREE.ConeGeometry(0.1, 0.07, 4, 1), 'timber', wood, mul(m, mat4(0, height + 0.035, 0, 0, Math.PI / 4, 0)));
      rbox(b, 'timber', wood, 0.46, 0.06, 0.06, at(0.2, height - 0.13, 0), 0.015);
      const braceLen = Math.hypot(0.2, 0.22);
      rbox(b, 'timber', wood, 0.045, braceLen, 0.045, at(0.11, height - 0.27, 0, -Math.atan2(0.2, 0.22)), 0.01);
      addLantern(b, rng, at(0.36, height - 0.16, 0));
      b.explode = radialExplode(p.x, p.z);
      return b;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pots beside the steps
// ---------------------------------------------------------------------------

type PotPlant = 'ball' | 'flowers' | 'spiky';

/** One or two terracotta pots flanking the door steps. */
function buildStoopPots(site: Site, rng: Rng): PartBuilder | null {
  const b = new PartBuilder('props:pots');
  const wall = site.front;
  const { stoop } = site.layout;
  const flowers = flowerColors(site.palette);
  for (const side of [-1, 1]) {
    if (!rng.chance(0.72)) continue;
    const count = rng.chance(0.4) ? 2 : 1;
    let w = WALL_GAP;
    for (let k = 0; k < count; k++) {
      const r = rng.range(0.14, 0.19) * (k ? 0.82 : 1);
      const potH = r * rng.range(1.5, 2);
      const plant = rng.weighted<PotPlant>([
        ['flowers', 4],
        ['ball', 2],
        ['spiky', 2],
      ]);
      const plantH = plant === 'ball' ? r * 2.3 : plant === 'spiky' ? r * 2.4 : r * 1.3;
      // The rim lip sticks out ~0.03 past r; keep that clear of the steps and the plinth band.
      const R = r + 0.03;
      const gap = rng.range(0.04, 0.08);
      const u = side < 0 ? stoop.u0 - gap - R : stoop.u1 + gap + R;
      const wc = w + R + (k ? 0.01 : rng.range(0, 0.05));
      const fp = site.standAgainst(wall, u - R, u + R, wc - R, wc + R, potH + plantH, 0.03);
      if (!fp) break;
      site.claim(fp, 'solid');
      const m = wallMatrix(wall, u, 0, wc);
      addPot(b, rng, m, r, potH);
      addPotPlant(b, rng, mul(m, mat4(0, potH - 0.04, 0)), plant, r, plantH, flowers);
      const foot = wallPoint(wall, u + side * r * 0.7, 0, wc + r * 0.7);
      site.anchors.push({ x: foot.x, z: foot.z, wall });
      w = wc + R;
    }
  }
  b.explode = wallExplode(wall, OUTWARD.props);
  return b.isEmpty ? null : b;
}

/** Terracotta pot (radius r at the rim, height h) with soil, standing at the origin of `m`. */
function addPot(b: PartBuilder, rng: Rng, m: THREE.Matrix4, r: number, h: number): void {
  const rb = r * 0.72;
  const lip = 0.025;
  const pts = [
    new THREE.Vector2(0.001, 0),
    new THREE.Vector2(rb, 0),
    new THREE.Vector2(rb * 1.02, 0.015),
    new THREE.Vector2(r - 0.01, h - 0.06),
    new THREE.Vector2(r + lip * 0.6, h - 0.055),
    new THREE.Vector2(r + lip, h - 0.035),
    new THREE.Vector2(r + lip * 0.85, h),
    new THREE.Vector2(r - 0.012, h),
    new THREE.Vector2(r - 0.02, h - 0.07),
  ];
  const color = vary(TERRACOTTA, rng, 0.06, 0.05, 0.015);
  b.add(new THREE.LatheGeometry(pts, 14), 'stone', color, m);
  const soil = new THREE.CircleGeometry(r - 0.015, 14).rotateX(-Math.PI / 2);
  b.add(soil, 'mortar', vary(SOIL, rng, 0.04, 0.03, 0), mul(m, mat4(0, h - 0.045, 0)));
}

/** Plant growing from the soil at the origin of `m` in a pot of radius r. */
function addPotPlant(b: PartBuilder, rng: Rng, m: THREE.Matrix4, kind: PotPlant, r: number, h: number, flowers: THREE.Color[]): void {
  if (kind === 'ball') {
    // Clipped box ball on a little trunk.
    const br = h * 0.36;
    b.add(new THREE.CylinderGeometry(0.012, 0.018, h - br, 5), 'wood', vary(BARK, rng), mul(m, mat4(0, (h - br) / 2, 0)));
    const leaf = vary(rng.pick(LEAVES), rng, 0.05, 0.05, 0.01);
    b.add(blobGeometry(2, rng.int(0, BLOB_VARIANTS - 1)), 'foliage', leaf, mul(m, mat4(0, h - br, 0, 0, 0, 0, br, br * 0.95, br)), shade(0.85));
  } else if (kind === 'flowers') {
    addFlowerClump(b, rng, m, r * 2.1, h, flowers, 0);
  } else {
    // Lavender-like: thin stems fanning out, tipped with colour.
    const tip = rng.chance(0.5) ? mix('#8a6cc4', '#efe7d6', 0.1) : rng.pick(flowers);
    const stem = vary('#7d9a5a', rng, 0.04, 0.04, 0.01);
    const n = rng.int(12, 18);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const lean = rng.range(0.05, 0.42);
      const len = h * rng.range(0.7, 1);
      const off = rng.range(0, r * 0.5);
      const sm = mul(m, mat4(Math.cos(a) * off, 0, Math.sin(a) * off, 0, a, lean, 0.008, len, 0.008));
      b.add(GRASS_BLADE, 'foliage', stem, sm);
      // Flower spike on the upper third of the stem.
      const top = new THREE.Vector3(0, 0.82, 0).applyMatrix4(sm);
      const spike = mat4(top.x, top.y, top.z, 0, a, lean, 0.016, len * 0.18, 0.016);
      b.add(FLOWER_HEAD, 'flower', vary(tip, rng, 0.05, 0.04, 0.01), spike);
    }
    addShrubBlob(b, rng, m, 0, 0.03, 0, r * 0.7, 0.07, r * 0.7, vary(rng.pick(LEAVES), rng), 1);
  }
}

/** Uniform shading multiplier as a paint function (used for small blobs). */
function shade(k: number) {
  return (_p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => {
    out.multiplyScalar(k + 0.2 * Math.max(0, n.y));
  };
}

// ---------------------------------------------------------------------------
// Wall items: woodpile, bench, barrels
// ---------------------------------------------------------------------------

/** Walls in random order, optionally with a preferred one first. */
function wallOrder(site: Site, rng: Rng, first?: WallSpec): WallSpec[] {
  const rest = site.walls.filter((w) => w !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first ? [first, ...rest] : rest;
}

/** Stack of split firewood against a gable wall (the chimney side when there is one). */
function buildWoodpile(site: Site, rng: Rng): PartBuilder | null {
  const { params, chimney } = site.layout;
  if (!rng.chance(chimney ? 0.8 : 0.4)) return null;
  const gables = site.walls.filter((w) => w.isGable);
  const back = site.walls.filter((w) => w.side === 'back');
  const preferred = chimney ? gables.find((w) => w.side === params.chimneySide) : rng.pick(gables);
  const walls = [...(preferred ? [preferred] : []), ...gables.filter((w) => w !== preferred), ...back];

  const depth = rng.range(0.34, 0.42);
  const roofed = rng.chance(0.5);
  let len = rng.range(1.3, 2.1);
  let height = rng.range(0.85, 1.25);
  for (let attempt = 0; attempt < 4; attempt++) {
    const extraLen = roofed ? 0.24 : 0.1;
    const extraH = roofed ? 0.34 : 0.06;
    const spot = site.findWallSpot(rng, walls, len + extraLen, WALL_GAP, WALL_GAP + depth + 0.12, height + extraH, true);
    if (spot) {
      const b = new PartBuilder('props:woodpile');
      b.explode = wallExplode(spot.wall, OUTWARD.props);
      const uc = (spot.u0 + spot.u1) / 2;
      const m = wallMatrix(spot.wall, uc, 0, WALL_GAP);
      const top = addWoodStack(b, rng, m, len, depth, height);
      if (roofed) addWoodpileRoof(b, rng, m, len, depth, top, site.palette);
      else addStakes(b, rng, m, len, depth, top, site.palette);
      addChoppingBlock(b, rng, site, spot.wall, uc, len, depth);
      return b;
    }
    len *= 0.8;
    height = Math.max(0.55, height * 0.82);
    if (len < 0.8) break;
  }
  return null;
}

/**
 * Rows of split logs, ends facing out, on two ground rails. Local frame of
 * `m`: x along the wall, z outward from the wall gap (z ∈ [0, depth]).
 * Returns the height of the top of the stack.
 */
function addWoodStack(b: PartBuilder, rng: Rng, m: THREE.Matrix4, len: number, depth: number, height: number): number {
  const rail = vary(BARK, rng, 0.04, 0.03, 0.01);
  for (const z of [0.07, depth - 0.07]) {
    rbox(b, 'timber', rail, len + 0.08, 0.07, 0.07, mul(m, mat4(rng.jitter(0.02), 0.035, z, 0, rng.jitter(0.015), 0)), 0.015);
  }
  const soup = new TriSoup();
  let top = 0.07;
  let row = 0;
  for (let y = 0.07; y + 0.1 < height; row++) {
    let x = -len / 2 + 0.02 + (row % 2 ? 0.05 : 0);
    let rowTop = y;
    for (;;) {
      const r = rng.range(0.052, 0.072);
      if (x + 2 * r > len / 2 - 0.01) break;
      const ragged = y + 0.26 > height && rng.chance(0.25);
      if (!ragged) {
        const z0 = rng.range(0, 0.03);
        addLog(soup, rng, x + r, y + r * 0.95, z0, z0 + depth + rng.jitter(0.02), r);
        rowTop = Math.max(rowTop, y + 2 * r);
      }
      x += 2 * r * 0.94 + rng.range(0, 0.015);
    }
    top = Math.max(top, rowTop);
    y += 0.118 + rng.jitter(0.008);
  }
  soup.addTo(b, 'wood', m);
  return top;
}

/** Cross-section of a split log: polygon (counter-clockwise) and which edges are split faces. */
function logSection(rng: Rng, r: number): { pts: THREE.Vector2[]; split: boolean[] } {
  const kind = rng.weighted<'round' | 'half' | 'wedge'>([
    ['round', 2],
    ['half', 4],
    ['wedge', 4],
  ]);
  const pts: THREE.Vector2[] = [];
  const split: boolean[] = [];
  if (kind === 'round') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const k = r * rng.range(0.9, 1.05);
      pts.push(new THREE.Vector2(Math.cos(a) * k, Math.sin(a) * k));
      split.push(false);
    }
  } else if (kind === 'half') {
    const R = r * 1.2;
    for (let i = 0; i <= 4; i++) {
      const a = (i / 4) * Math.PI;
      pts.push(new THREE.Vector2(Math.cos(a) * R, Math.sin(a) * R - R * 0.42));
      split.push(i === 4); // the closing edge back to the start is the flat split face
    }
  } else {
    const R = r * 1.55;
    pts.push(new THREE.Vector2(-R * 0.55, 0));
    split.push(true);
    for (let i = 0; i < 3; i++) {
      const a = -0.72 + i * 0.72;
      pts.push(new THREE.Vector2(Math.cos(a) * R - R * 0.55, Math.sin(a) * R));
      split.push(i === 2);
    }
  }
  return { pts, split };
}

/** One split log along local z from z0 to z1, centred at (cx, cy). */
function addLog(soup: TriSoup, rng: Rng, cx: number, cy: number, z0: number, z1: number, r: number): void {
  const { pts, split } = logSection(rng, r);
  const rot = new THREE.Matrix3().rotate(rng.range(0, Math.PI * 2));
  const p2 = pts.map((p) => p.clone().applyMatrix3(rot).add(new THREE.Vector2(cx, cy)));
  const end = vary(END_GRAIN, rng, 0.07, 0.05, 0.012);
  const splitC = vary(SPLIT_WOOD, rng, 0.06, 0.05, 0.01);
  const bark = vary(BARK, rng, 0.06, 0.05, 0.01);
  const centre = p2.reduce((s, p) => s.add(p), new THREE.Vector2()).multiplyScalar(1 / p2.length);
  const v = (p: THREE.Vector2, z: number) => new THREE.Vector3(p.x, p.y, z);
  const n = p2.length;
  for (let i = 0; i < n; i++) {
    const a = p2[i];
    const c = p2[(i + 1) % n];
    // End caps: the outer end faces +z (away from the wall), the inner one -z.
    soup.tri({ p: v(centre, z1), c: end }, { p: v(a, z1), c: end }, { p: v(c, z1), c: end });
    soup.tri({ p: v(centre, z0), c: end }, { p: v(c, z0), c: end }, { p: v(a, z0), c: end });
    soup.quad(v(a, z0), v(c, z0), v(c, z1), v(a, z1), split[i] ? splitC : bark);
  }
}

/** Two stakes at each end of a woodpile keep the stack from rolling. */
function addStakes(b: PartBuilder, rng: Rng, m: THREE.Matrix4, len: number, depth: number, top: number, pal: Palette): void {
  const wood = vary(pal.timber, rng, 0.05, 0.03, 0.01);
  for (const sx of [-1, 1]) {
    for (const z of [0.05, depth - 0.05]) {
      const h = top + rng.range(0.02, 0.1);
      rbox(b, 'timber', wood, 0.05, h, 0.05, mul(m, mat4(sx * (len / 2 + 0.03), h / 2, z, rng.jitter(0.03), 0, sx * rng.range(0, 0.05))), 0.012);
    }
  }
}

/** Little lean-to roof of planks on two posts, sloping away from the wall. */
function addWoodpileRoof(b: PartBuilder, rng: Rng, m: THREE.Matrix4, len: number, depth: number, top: number, pal: Palette): void {
  const wood = vary(pal.timber, rng, 0.04, 0.03, 0.01);
  const backZ = -WALL_GAP + 0.08; // the ledger sits on the wall face at w = 0.08
  const frontZ = depth + 0.18;
  const backY = top + 0.3;
  const frontY = top + 0.1;
  const half = len / 2 + 0.1;
  // Ledger on the wall and beam on the posts.
  rbox(b, 'timber', wood, half * 2, 0.08, 0.06, mul(m, mat4(0, backY - 0.06, backZ + 0.03)), 0.015);
  rbox(b, 'timber', wood, half * 2, 0.07, 0.07, mul(m, mat4(0, frontY - 0.05, depth + 0.06)), 0.015);
  for (const sx of [-1, 1]) {
    const h = frontY - 0.05;
    rbox(b, 'timber', wood, 0.07, h, 0.07, mul(m, mat4(sx * (half - 0.05), h / 2, depth + 0.06)), 0.015);
  }
  // Planks running down the slope.
  const slope = Math.atan2(backY - frontY, frontZ - backZ);
  const plankLen = Math.hypot(backY - frontY, frontZ - backZ);
  const n = Math.max(3, Math.round((half * 2) / 0.17));
  const pw = (half * 2) / n;
  for (let i = 0; i < n; i++) {
    const x = -half + pw * (i + 0.5);
    const c = vary(mix(pal.wood, WEATHERED, 0.35), rng, 0.05, 0.03, 0.01);
    const yMid = (backY + frontY) / 2 + 0.02;
    // A little shorter than the slope so the top end never reaches back into the wall's stones.
    const len = plankLen - rng.range(0.03, 0.07);
    rbox(b, 'wood', c, pw - 0.012, 0.028, len, mul(m, mat4(x, yMid, (backZ + frontZ) / 2 + 0.02, slope, rng.jitter(0.01), 0)), 0.008);
  }
}

/** Chopping block with an axe, and a few split logs lying about, in front of the woodpile. */
function addChoppingBlock(b: PartBuilder, rng: Rng, site: Site, wall: WallSpec, uc: number, len: number, depth: number): void {
  if (!rng.chance(0.6)) return;
  const r = rng.range(0.17, 0.22);
  const h = rng.range(0.32, 0.42);
  // The block, the axe and the loose logs all lie on the side away from the
  // pile: u ∈ [u - r - 0.37, u + r + 0.37], w ∈ [w - r, w + r + 0.37].
  for (let attempt = 0; attempt < 6; attempt++) {
    const u = uc + rng.jitter(Math.max(0, len / 2));
    const w = WALL_GAP + depth + 0.12 + rng.range(0.2, 0.45) + r;
    const fp = site.wallFootprint(wall, u - r - 0.37, u + r + 0.37, w - r, w + r + 0.37);
    if (!site.fits(fp, 0.04) || site.headroom(fp) < 1.2) continue;
    site.claim(fp, 'solid');
    const p = wallPoint(wall, u, 0, w);
    site.anchors.push({ x: p.x, z: p.z, wall });
    addBlockAndAxe(b, rng, wallMatrix(wall, u, 0, w), r, h);
    return;
  }
}

/** Chopping block of radius r and height h at the origin of `m`, axe and logs towards local +z. */
function addBlockAndAxe(b: PartBuilder, rng: Rng, m: THREE.Matrix4, r: number, h: number): void {
  const end = new THREE.Color(END_GRAIN);
  const block = new THREE.CylinderGeometry(r, r * 1.06, h, 12, 1);
  b.add(block, 'wood', vary(BARK, rng), mul(m, mat4(0, h / 2, 0, 0, rng.range(0, 6), 0)), (_p, n, out) => {
    if (n.y > 0.7) out.copy(end);
  });
  // Axe: handle rising at ~55° away from the wall, iron head bitten into the top.
  const am = mul(m, mat4(0, h, 0, 0, rng.jitter(0.9), 0));
  const tilt = 0.96;
  const handle = 0.55;
  const hy = Math.sin(tilt) * handle * 0.5;
  const hz = Math.cos(tilt) * handle * 0.5;
  rbox(b, 'wood', vary('#8a6a48', rng), 0.032, 0.03, handle, mul(am, mat4(0, hy, hz, -tilt, 0, 0)), 0.01);
  rbox(b, 'metal', vary('#5b5651', rng, 0.03, 0.02, 0), 0.025, 0.11, 0.16, mul(am, mat4(0, 0.02, -0.02, -tilt + Math.PI / 2, 0, 0)), 0.006);
  // A few split logs lying on the ground beside it (never towards the woodpile).
  const k = rng.int(1, 3);
  for (let i = 0; i < k; i++) {
    const a = rng.range(0.2, Math.PI - 0.2);
    const d = r + rng.range(0.1, 0.2);
    const lr = rng.range(0.05, 0.065);
    const lm = mat4(Math.cos(a) * d, 0, Math.sin(a) * d, 0, rng.range(0, Math.PI * 2), 0);
    const log = new TriSoup();
    addLog(log, rng, 0, lr * 0.75, -0.17, 0.17, lr);
    log.addTo(b, 'wood', mul(m, lm));
  }
}

/** Wooden bench against a wall, often under a window. */
function buildBench(site: Site, rng: Rng): PartBuilder | null {
  if (!rng.chance(0.75)) return null;
  const len = rng.range(1.15, 1.65);
  const depth = rng.range(0.34, 0.4);
  const seatH = rng.range(0.42, 0.46);
  const front = rng.chance(0.65) ? site.front : undefined;
  const walls = wallOrder(site, rng, front);
  let withPot = rng.chance(0.35);
  let spot = site.findWallSpot(rng, walls, len, WALL_GAP, WALL_GAP + depth, seatH + (withPot ? 0.42 : 0.04));
  if (!spot && withPot) {
    withPot = false;
    spot = site.findWallSpot(rng, walls, len, WALL_GAP, WALL_GAP + depth, seatH + 0.04);
  }
  if (!spot) return null;
  const b = new PartBuilder('props:bench');
  b.explode = wallExplode(spot.wall, OUTWARD.props);
  const m = wallMatrix(spot.wall, (spot.u0 + spot.u1) / 2, 0, WALL_GAP + depth / 2);
  addBench(b, rng, m, len, depth, seatH, site.palette);
  if (withPot) {
    const side = rng.chance(0.5) ? -1 : 1;
    const r = rng.range(0.08, 0.1);
    const pm = mul(m, mat4(side * (len / 2 - r - 0.08), seatH, rng.jitter(0.03)));
    const potH = r * 1.7;
    addPot(b, rng, pm, r, potH);
    addPotPlant(b, rng, mul(pm, mat4(0, potH - 0.04, 0)), rng.chance(0.6) ? 'flowers' : 'spiky', r, r * 2, flowerColors(site.palette));
  }
  return b;
}

/** Plank seat on slab or post legs. Origin: centre of the bench's footprint on the ground. */
function addBench(b: PartBuilder, rng: Rng, m: THREE.Matrix4, len: number, depth: number, seatH: number, pal: Palette): void {
  const wood = mix(pal.wood, WEATHERED, 0.25);
  const t = 0.055;
  const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => mul(m, mat4(x, y, z, rx, ry, rz));
  for (const zs of [-1, 1]) {
    const pw = depth / 2 - 0.008;
    rbox(b, 'wood', vary(wood, rng, 0.05, 0.03, 0.01), len + rng.jitter(0.03), t, pw, at(rng.jitter(0.01), seatH - t / 2 + rng.jitter(0.004), (zs * depth) / 4, 0, rng.jitter(0.01), rng.jitter(0.006)), 0.014);
  }
  const legH = seatH - t;
  if (rng.chance(0.5)) {
    // Two slab legs joined by a stretcher.
    for (const sx of [-1, 1]) {
      rbox(b, 'wood', vary(wood, rng, 0.05, 0.03, 0.01), 0.065, legH, depth * 0.84, at(sx * (len / 2 - 0.17), legH / 2, 0, 0, 0, rng.jitter(0.02)), 0.015);
    }
    rbox(b, 'wood', vary(wood, rng, 0.05, 0.03, 0.01), len - 0.34, 0.06, 0.05, at(0, 0.17, 0), 0.012);
  } else {
    // Four splayed round legs with side rails.
    const leg = new THREE.CylinderGeometry(0.03, 0.036, legH + 0.02, 7);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const c = vary(wood, rng, 0.05, 0.03, 0.01);
        b.add(leg, 'wood', c, at(sx * (len / 2 - 0.13), legH / 2, sz * (depth / 2 - 0.07), sz * 0.07, 0, -sx * 0.09));
      }
      rbox(b, 'wood', vary(wood, rng, 0.05, 0.03, 0.01), 0.04, 0.04, depth - 0.1, at(sx * (len / 2 - 0.115), 0.15, 0), 0.01);
    }
  }
}

/** One or two barrels, sometimes with a crate of apples, against a wall. */
function buildBarrels(site: Site, rng: Rng): PartBuilder | null {
  if (!rng.chance(0.65)) return null;
  type Item = { kind: 'barrel'; r: number; h: number } | { kind: 'crate'; w: number; d: number; h: number };
  const items: Item[] = [];
  const n = rng.chance(0.45) ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.25, 0.3) * (i ? 0.92 : 1);
    items.push({ kind: 'barrel', r, h: r * rng.range(2.7, 3.1) });
  }
  if (rng.chance(0.4)) items.push({ kind: 'crate', w: rng.range(0.46, 0.56), d: rng.range(0.36, 0.42), h: rng.range(0.3, 0.38) });
  // Shuffle so the crate is not always last.
  if (items.length > 1 && rng.chance(0.5)) items.reverse();
  const widthOf = (it: Item) => (it.kind === 'barrel' ? it.r * 2 : it.w);
  const gap = 0.03;
  const len = items.reduce((s, it) => s + widthOf(it), 0) + gap * (items.length - 1);
  const depth = Math.max(...items.map((it) => (it.kind === 'barrel' ? it.r * 2 : it.d))) + 0.04;
  const height = Math.max(...items.map((it) => (it.kind === 'barrel' ? it.h : it.h + 0.12)));
  const back = site.walls.find((w) => w.side === 'back');
  const walls = wallOrder(site, rng, rng.chance(0.5) ? back : undefined);
  const spot = site.findWallSpot(rng, walls, len, WALL_GAP, WALL_GAP + depth, height + 0.04, true);
  if (!spot) return null;

  const b = new PartBuilder('props:barrels');
  b.explode = wallExplode(spot.wall, OUTWARD.props);
  const wood = mix(site.palette.wood, WEATHERED, 0.15);
  let u = spot.u0;
  for (const it of items) {
    const width = widthOf(it);
    if (it.kind === 'barrel') {
      const m = wallMatrix(spot.wall, u + width / 2, 0, WALL_GAP + it.r + rng.range(0, 0.03));
      addBarrel(b, rng, mul(m, mat4(0, 0, 0, 0, rng.range(0, Math.PI * 2), 0)), it.r, it.h, wood);
    } else {
      const m = wallMatrix(spot.wall, u + width / 2, 0, WALL_GAP + it.d / 2 + 0.02);
      addCrate(b, rng, mul(m, mat4(0, 0, 0, 0, rng.jitter(0.08), 0)), it.w, it.d, it.h, wood);
    }
    u += width + gap;
  }
  return b;
}

/** Barrel of `staves` bulging planks with iron hoops; origin at the centre of its foot. */
function addBarrel(b: PartBuilder, rng: Rng, m: THREE.Matrix4, R: number, H: number, wood: ColorLike): void {
  const staves = 12;
  const end = R * 0.85;
  const profile = (y: number) => end + (R - end) * Math.sin((Math.PI * y) / H);
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k <= 6; k++) pts.push(new THREE.Vector2(profile((H * k) / 6), (H * k) / 6));
  pts.push(new THREE.Vector2(end - 0.022, H), new THREE.Vector2(end - 0.022, H - 0.04));
  const step = (Math.PI * 2) / staves;
  for (let s = 0; s < staves; s++) {
    b.add(new THREE.LatheGeometry(pts, 1, s * step, step), 'wood', vary(wood, rng, 0.06, 0.04, 0.01), m);
  }
  const lid = new THREE.CylinderGeometry(end - 0.02, end - 0.02, 0.02, staves);
  b.add(lid, 'wood', vary(wood, rng, 0.04, 0.03, 0.01).multiplyScalar(0.82), mul(m, mat4(0, H - 0.05, 0)));
  // Hoops share the staves' segment angles so they wrap the facets exactly.
  const iron = vary(IRON, rng, 0.04, 0.03, 0.01);
  for (const f of [0.1, 0.27, 0.73, 0.9]) {
    const y = H * f;
    const r = Math.max(profile(y - 0.025), profile(y + 0.025)) + 0.007;
    const hoop = [
      new THREE.Vector2(r - 0.004, y - 0.024),
      new THREE.Vector2(r, y - 0.018),
      new THREE.Vector2(r, y + 0.018),
      new THREE.Vector2(r - 0.004, y + 0.024),
    ];
    b.add(new THREE.LatheGeometry(hoop, staves), 'metal', iron, m);
  }
}

/** Slatted crate, filled with apples; origin at the centre of its foot. */
function addCrate(b: PartBuilder, rng: Rng, m: THREE.Matrix4, w: number, d: number, h: number, wood: ColorLike): void {
  const at = (x: number, y: number, z: number) => mul(m, mat4(x, y, z));
  const rows = 3;
  const sh = h / rows - 0.016;
  for (let i = 0; i < rows; i++) {
    const y = (i + 0.5) * (h / rows);
    for (const s of [-1, 1]) {
      rbox(b, 'wood', vary(wood, rng, 0.06, 0.04, 0.01), w, sh, 0.02, at(0, y, s * (d / 2 - 0.01)));
      rbox(b, 'wood', vary(wood, rng, 0.06, 0.04, 0.01), 0.02, sh, d - 0.04, at(s * (w / 2 - 0.01), y, 0));
    }
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) rbox(b, 'wood', vary(wood, rng, 0.05, 0.03, 0.01).multiplyScalar(0.85), 0.04, h, 0.04, at(sx * (w / 2 - 0.03), h / 2, sz * (d / 2 - 0.03)), 0.008);
  }
  // Fill: a bed just under the rim, heaped with apples.
  rbox(b, 'wood', vary(SOIL, rng), w - 0.04, 0.02, d - 0.04, at(0, h - 0.07, 0));
  const apple = rng.pick(['#b8382c', '#c9532f', '#9fb83c', '#d6a33a']);
  const nx = Math.max(2, Math.floor((w - 0.06) / 0.085));
  const nz = Math.max(2, Math.floor((d - 0.06) / 0.085));
  const geo = new THREE.IcosahedronGeometry(0.042, 1);
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      const x = -((nx - 1) * 0.085) / 2 + i * 0.085 + rng.jitter(0.01);
      const z = -((nz - 1) * 0.085) / 2 + k * 0.085 + rng.jitter(0.01);
      const lift = rng.chance(0.3) ? 0.03 : 0;
      b.add(geo, 'flower', vary(apple, rng, 0.06, 0.05, 0.015), at(x, h - 0.025 + lift, z));
    }
  }
}

// ---------------------------------------------------------------------------
// Planting: shrubs, flowers and grass along the walls
// ---------------------------------------------------------------------------

type PlantKind = 'shrub' | 'flowers' | 'hollyhock';

/**
 * Walk along every ground-floor wall dropping shrubs, flower clumps and the
 * odd stand of hollyhocks into the gaps, each low enough for the windows
 * above it; then sprinkle grass tufts along the base and at the feet of
 * everything that was placed.
 */
function buildPlanting(site: Site, rng: Rng): PartBuilder[] {
  const lush = rng.range(0.6, 1);
  const flowers = flowerColors(site.palette);
  const builders = new Map<WallSpec, PartBuilder>();
  for (const wall of site.walls) {
    const b = new PartBuilder(`props:plants:${wall.side}`);
    b.explode = wallExplode(wall, OUTWARD.props);
    builders.set(wall, b);
    const sideFactor = wall.side === 'front' ? 1.25 : wall.side === 'back' ? 0.7 : 0.9;
    plantAlongWall(b, rng, site, wall, lush * sideFactor * rng.range(0.8, 1.2), flowers);
  }
  for (const wall of site.walls) {
    const b = builders.get(wall)!;
    const count = Math.round(wall.length * 2.4 * (0.6 + lush * 0.6));
    for (let i = 0; i < count; i++) {
      const u = rng.range(-0.05, wall.length + 0.05);
      const w = WALL_GAP + 0.02 + Math.pow(rng.next(), 1.6) * 0.6;
      const p = wallPoint(wall, u, 0, w);
      if (site.grassFits(p.x, p.z)) addTuft(b, rng, p.x, p.z, rng.range(0.75, 1.15), wall.normal);
    }
  }
  for (const a of site.anchors) {
    if (!rng.chance(0.75)) continue;
    const x = a.x + rng.jitter(0.08);
    const z = a.z + rng.jitter(0.08);
    if (!site.grassFits(x, z)) continue;
    const b = a.wall ? builders.get(a.wall) : builders.get(site.front);
    if (b) addTuft(b, rng, x, z, rng.range(0.9, 1.25), site.wallNormalNear(x, z));
  }
  return [...builders.values()];
}

function plantAlongWall(b: PartBuilder, rng: Rng, site: Site, wall: WallSpec, lush: number, flowers: THREE.Color[]): void {
  // A dominant flower colour per wall keeps the beds from looking like confetti.
  const main = rng.pick(flowers);
  let u = rng.range(0.05, 0.6);
  while (u < wall.length - 0.3) {
    const probe = Math.min(site.heightLimit(wall, u, u + 0.7), site.headroom(site.wallFootprint(wall, u, u + 0.7, WALL_GAP, WALL_GAP + 0.7)));
    const kind = choosePlant(rng, probe, lush);
    if (!kind) {
      u += 0.25;
      continue;
    }
    const size =
      kind === 'shrub'
        ? { w: rng.range(0.55, 1.0), h: Math.min(probe - 0.06, rng.range(0.5, 0.95)) }
        : kind === 'hollyhock'
          ? { w: rng.range(0.35, 0.55), h: Math.min(probe - 0.1, rng.range(1.15, 1.75)) }
          : { w: rng.range(0.4, 0.7), h: Math.min(probe - 0.05, rng.range(0.22, 0.36)) };
    if (u + size.w > wall.length + 0.2) break; // may wrap a little round the corner, no more
    const depth = kind === 'hollyhock' ? size.w * 0.8 : size.w * rng.range(0.8, 1);
    // Plants may nestle into each other a little, but keep clear of paths and solid things.
    const fp = site.standAgainst(wall, u, u + size.w, WALL_GAP, WALL_GAP + depth, size.h, 0.03, -0.06);
    if (!fp) {
      u += 0.2;
      continue;
    }
    site.claim(fp, 'plant');
    const m = wallMatrix(wall, u + size.w / 2, 0, WALL_GAP + depth / 2);
    const color = rng.chance(0.7) ? main : rng.pick(flowers);
    if (kind === 'shrub') addShrub(b, rng, m, size.w, size.h, depth, rng.chance(0.45) ? color : null);
    else if (kind === 'hollyhock') addHollyhocks(b, rng, m, size.w, size.h, depth, color);
    else addFlowerClump(b, rng, m, size.w, size.h, rng.chance(0.6) ? [color] : flowers, depth / 2);
    const foot = wallPoint(wall, u + size.w * rng.range(0, 1), 0, WALL_GAP + depth);
    site.anchors.push({ x: foot.x, z: foot.z, wall });
    u += size.w + rng.range(-0.1, 0.7) / lush;
  }
}

/** Pick a plant that fits under the height limit (or none for a gap). */
function choosePlant(rng: Rng, limit: number, lush: number): PlantKind | null {
  if (!rng.chance(0.6 + 0.35 * lush)) return null;
  if (limit >= 1.4 && rng.chance(0.18)) return 'hollyhock';
  if (limit >= 0.55 && rng.chance(0.55)) return 'shrub';
  if (limit >= 0.26) return 'flowers';
  return null;
}

/** One foliage blob: ellipsoid centred at (x, y, z) with radii (rx, ry, rz) in the frame of `m`. */
function addShrubBlob(
  b: PartBuilder,
  rng: Rng,
  m: THREE.Matrix4,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
  color: THREE.Color,
  detail: number,
  height = y + ry,
): number {
  const variant = rng.int(0, BLOB_VARIANTS - 1);
  b.add(blobGeometry(detail, variant), 'foliage', color, mul(m, mat4(x, y, z, 0, 0, 0, rx, ry, rz)), foliagePaint(height));
  return variant;
}

/** A foliage ellipsoid as placed by the plant builders (centre, radii, noise variant). */
interface Blob {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  v: number;
}

/** Point on a blob's (noisy) surface in unit direction d, pushed out by `lift`. */
function blobSurface(blob: Blob, d: THREE.Vector3, lift = 0): THREE.Vector3 {
  const k = blobRadius(d, blob.v) + lift;
  return new THREE.Vector3(blob.x + d.x * blob.rx * k, blob.y + d.y * blob.ry * k, blob.z + d.z * blob.rz * k);
}

/** Random direction on the upper, outward-facing (+z, away from the wall) part of a blob. */
function upperDirection(rng: Rng, minY: number): THREE.Vector3 {
  const d = new THREE.Vector3(rng.jitter(1), rng.range(minY, 1), rng.jitter(1));
  if (d.z < -0.3) d.z = -d.z;
  return d.normalize();
}

/**
 * Rounded bush: a main mass, 1–3 side blobs and a crown of small lumps that
 * break up the silhouette. Origin of `m`: centre of its footprint on the
 * ground, local z pointing away from the wall; the footprint is
 * width × depth and nothing rises above `height`.
 */
function addShrub(b: PartBuilder, rng: Rng, m: THREE.Matrix4, width: number, height: number, depth: number, flower: THREE.Color | null): void {
  const leaf = vary(rng.pick(LEAVES), rng, 0.05, 0.05, 0.012);
  // Main mass: its bottom sinks below ground so the bush looks rooted.
  // Blob noise reaches ~15 % past the nominal radius and flowers sit on top of
  // that: keep both inside the footprint.
  const halfW = width / 2 - FLOWER_MARGIN;
  const halfD = depth / 2 - FLOWER_MARGIN;
  const rx = halfW / BLOB_BULGE;
  const rz = Math.min(rx, halfD / BLOB_BULGE);
  const ry = height * 0.5;
  const main: Blob = { x: 0, y: height - ry * 1.32, z: 0, rx, ry, rz, v: 0 };
  main.v = addShrubBlob(b, rng, m, main.x, main.y, main.z, rx, ry, rz, leaf, rx > 0.3 ? 2 : 1, height);
  const blobs: Blob[] = [main];
  const extra = rng.int(1, 3);
  for (let i = 0; i < extra; i++) {
    const s = rng.range(0.5, 0.7);
    const a = rng.range(0, Math.PI * 2);
    const blob: Blob = {
      x: THREE.MathUtils.clamp(Math.cos(a) * rx * 0.6, -halfW + rx * s * BLOB_BULGE, halfW - rx * s * BLOB_BULGE),
      y: ry * s * 0.5,
      z: THREE.MathUtils.clamp(Math.sin(a) * rz * 0.6, -halfD + rz * s * BLOB_BULGE, halfD - rz * s * BLOB_BULGE),
      rx: rx * s,
      ry: ry * s,
      rz: rz * s,
      v: 0,
    };
    blob.v = addShrubBlob(b, rng, m, blob.x, blob.y, blob.z, blob.rx, blob.ry, blob.rz, vary(leaf, rng, 0.03, 0.03, 0.006), 1, height);
    blobs.push(blob);
  }
  // Crown lumps, a shade lighter where the sun catches the new growth.
  const lumps = rng.int(2, 4);
  for (let i = 0; i < lumps; i++) {
    const p = blobSurface(main, upperDirection(rng, 0.25), -0.22);
    const r = rx * rng.range(0.34, 0.48);
    const lr = Math.min(r, rz * 0.7);
    const lump: Blob = {
      x: THREE.MathUtils.clamp(p.x, -halfW + r * BLOB_BULGE, halfW - r * BLOB_BULGE),
      y: Math.min(p.y, height - r * 0.85 * BLOB_BULGE),
      z: THREE.MathUtils.clamp(p.z, -halfD + lr * BLOB_BULGE, halfD - lr * BLOB_BULGE),
      rx: r,
      ry: r * 0.85,
      rz: lr,
      v: 0,
    };
    const c = vary(leaf, rng, 0.03, 0.03, 0.006).offsetHSL(0, 0, 0.025);
    lump.v = addShrubBlob(b, rng, m, lump.x, lump.y, lump.z, lump.rx, lump.ry, lump.rz, c, 1, height);
    blobs.push(lump);
  }
  if (flower) {
    const count = Math.round(width * 22);
    for (let i = 0; i < count; i++) addFlowerOnBlob(b, rng, m, rng.pick(blobs), flower, 0.032);
  }
}

/**
 * Little open flower (a hexagonal cup with a darker throat) sitting on the
 * upper surface of a foliage blob, facing out along the surface normal.
 */
function addFlowerOnBlob(b: PartBuilder, rng: Rng, m: THREE.Matrix4, blob: Blob, color: THREE.Color, size: number): void {
  const d = upperDirection(rng, 0.1);
  const local = blobSurface(blob, d, 0.01);
  // Ellipsoid normal, then into world space with the blob's frame.
  const normal = new THREE.Vector3(d.x / blob.rx, d.y / blob.ry, d.z / blob.rz).normalize().transformDirection(m);
  const pos = local.applyMatrix4(m);
  const s = size * rng.range(0.8, 1.25);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, normal);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, rng.range(0, Math.PI)));
  const fm = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(s, s, s));
  addFlowerCup(b, fm, vary(color, rng, 0.05, 0.04, 0.01), s);
}

/** A FLOWER_CUP placed by `fm` (scale s), painted with a darker throat. */
function addFlowerCup(b: PartBuilder, fm: THREE.Matrix4, color: THREE.Color, s: number): void {
  const throat = color.clone().multiplyScalar(0.62);
  const centre = new THREE.Vector3(0, 0.2, 0).applyMatrix4(fm);
  b.add(FLOWER_CUP, 'flower', color, fm, (p, _n, out) => {
    out.copy(throat).lerp(color, THREE.MathUtils.clamp(p.distanceTo(centre) / (s * 0.75), 0, 1));
  });
}

/** Low mound of leaves covered in flowers. Origin of `m`: centre on the ground. */
function addFlowerClump(b: PartBuilder, rng: Rng, m: THREE.Matrix4, width: number, height: number, colors: THREE.Color[], zHalf: number): void {
  const leaf = vary(rng.pick(LEAVES), rng, 0.05, 0.05, 0.012);
  // Against a wall the mound (and its flowers) stay inside the footprint; in a pot it may spill over the rim.
  const fitted = zHalf > 0;
  const rx = fitted ? (width / 2 - FLOWER_MARGIN) / BLOB_BULGE : width * 0.5;
  const rz = fitted ? Math.min(rx * 0.85, (zHalf - FLOWER_MARGIN) / BLOB_BULGE) : rx * 0.85;
  const ry = height * 0.72;
  const mound: Blob = { x: 0, y: height - ry * 1.12, z: 0, rx, ry, rz, v: 0 };
  mound.v = addShrubBlob(b, rng, m, 0, mound.y, 0, rx, ry, rz, leaf, rx > 0.28 ? 2 : 1, height);
  // Smaller blooms on small clumps (pots on a bench) so they don't look like blotches.
  const size = Math.min(0.034, 0.012 + width * 0.05);
  const count = Math.round(6 + width * 22);
  for (let i = 0; i < count; i++) addFlowerOnBlob(b, rng, m, mound, rng.pick(colors), size);
}

/** Tall cottage-garden hollyhocks: a leafy base and 2–4 spires of open, cup-shaped flowers. */
function addHollyhocks(b: PartBuilder, rng: Rng, m: THREE.Matrix4, width: number, height: number, depth: number, color: THREE.Color): void {
  const leaf = vary(rng.pick(LEAVES), rng, 0.05, 0.05, 0.012);
  addShrubBlob(b, rng, m, 0, 0.1, 0, (width / 2 - 0.02) / BLOB_BULGE, 0.3, (depth / 2 - 0.02) / BLOB_BULGE, leaf, 1, 0.4);
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const x = -width * 0.3 + (width * 0.6 * i) / (n - 1) + rng.jitter(0.04);
    const z = rng.jitter(depth * 0.15);
    const h = height * rng.range(0.78, 1);
    // Stems lean a little away from the wall (local +z), never into it.
    const sm = mul(m, mat4(x, 0, z, rng.range(0, 0.07), 0, rng.jitter(0.08)));
    b.add(HOLLYHOCK_STEM, 'foliage', vary('#6f8f4a', rng, 0.04, 0.04, 0.01), mul(sm, mat4(0, 0, 0, 0, 0, 0, 1, h, 1)));
    // Broad leaves on the lower stem.
    for (let y = 0.32; y < h * 0.45; y += rng.range(0.12, 0.17)) {
      const a = rng.range(Math.PI * 1.05, Math.PI * 1.95); // leaves point away from the wall
      const lm = mul(sm, mat4(Math.cos(a) * 0.06, y, -Math.sin(a) * 0.06, 0, a, -0.35, 0.1, 0.022, 0.075));
      b.add(PEBBLE, 'foliage', vary(leaf, rng, 0.04, 0.03, 0.01), lm);
    }
    // Open flowers spiralling up the upper half, shrinking to green buds at the tip.
    const c = vary(color, rng, 0.04, 0.04, 0.01);
    let a = rng.range(0, Math.PI * 2);
    for (let y = h * 0.45; y < h - 0.02; y += rng.range(0.055, 0.075)) {
      const t = (y - h * 0.45) / (h * 0.55);
      a += rng.range(1.6, 2.6);
      const s = 0.06 * (1 - t * 0.6);
      const bud = t > 0.82;
      const fm = mul(sm, mat4(Math.cos(a) * 0.02, y, -Math.sin(a) * 0.02, 0, a, -Math.PI / 2 + rng.range(0.1, 0.5), s, s * 0.5, s));
      if (bud) {
        b.add(PEBBLE, 'foliage', c.clone().lerp(leaf, 0.55), mul(fm, mat4(0, 0, 0, 0, 0, 0, 0.6, 1.4, 0.6)));
        continue;
      }
      addFlowerCup(b, fm, c, s);
    }
  }
}

/**
 * A tuft of grass blades at plan (x, z). Blades that would lean towards
 * `away`'s opposite (e.g. into a wall) are mirrored to lean away instead.
 */
function addTuft(b: PartBuilder, rng: Rng, x: number, z: number, scale: number, away: { x: number; z: number } | null = null, maxTilt = 0.55): void {
  const root = vary(GRASS_ROOT, rng, 0.04, 0.04, 0.012);
  const tip = vary(GRASS_TIP, rng, 0.05, 0.05, 0.015);
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    let yaw = rng.range(0, Math.PI * 2);
    const tilt = rng.range(0.08, maxTilt);
    const h = scale * rng.range(0.11, 0.24);
    const off = rng.range(0, 0.035);
    const r = scale * rng.range(0.011, 0.016);
    if (away) {
      // With Euler (0, yaw, tilt) a blade leans towards (-cos yaw, 0, sin yaw).
      const lx = -Math.cos(yaw);
      const lz = Math.sin(yaw);
      const d = lx * away.x + lz * away.z;
      if (d < 0) yaw = Math.atan2(lz - 2 * d * away.z, -(lx - 2 * d * away.x));
    }
    const m = mat4(x + Math.cos(yaw) * off, 0, z - Math.sin(yaw) * off, 0, yaw, tilt, r, h, r);
    const top = h * Math.cos(tilt);
    b.add(GRASS_BLADE, 'foliage', root, m, (p, _n, out) => {
      out.copy(root).lerp(tip, THREE.MathUtils.clamp(p.y / top, 0, 1));
    });
  }
}
