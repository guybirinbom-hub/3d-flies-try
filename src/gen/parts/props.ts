import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PartBuilder, boxGeometry, mat4, mix, mul, vary, type ColorLike, type MatKey } from '../builder';
import { OUTWARD, wallExplode } from '../explode';
import type { PartDef } from '../house';
import { roofUndersideY, wallMatrix, wallPoint, type HouseLayout, type Opening, type RoofCovering, type WallSpec } from '../layout';
import type { Palette } from '../params';
import type { Rng } from '../rng';

/**
 * Props: the life around the house. A path from the door steps that fades
 * into the lawn, a lantern beside the door hood, pots beside the steps, a
 * lean-to woodshed against a gable (or a plain woodpile), a bench and
 * barrels against the walls, a climbing rose or ivy up a corner or beside
 * the door, flower spikes, groups of shrubs and flowers along the base and
 * grass tufts that blend the house into the ground. Small repeated detail
 * thins out with `layout.detail` and the part's triangle budget.
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
    const beds = new Beds(site);
    // Order matters: earlier items claim their ground first. The path and the
    // lantern are the most important; plants and grass fill in around the rest.
    const builders = [
      buildPath(site, rng.fork('path')),
      buildLantern(site, rng.fork('lantern')),
      buildStoopPots(site, rng.fork('pots')),
    ];
    // About half the houses get a lean-to woodshed instead of a plain woodpile.
    const shed = buildWoodshed(site, rng.fork('woodshed'));
    builders.push(shed);
    // A climber and flower spikes by the door / corners go before the
    // furniture so they get their spots.
    builders.push(buildClimber(site, rng.fork('climber')));
    buildSpikes(site, beds, rng.fork('spikes'));
    if (!shed) builders.push(buildWoodpile(site, rng.fork('woodpile')));
    builders.push(buildBench(site, rng.fork('bench')), buildBarrels(site, rng.fork('barrels')));
    // Planting fills in last and thins out when the rest already used much of the budget.
    const used = builders.reduce((n, b) => n + (b?.triangles ?? 0), 0);
    buildPlanting(site, beds, rng.fork('planting'), PROPS_BUDGET - used);
    builders.push(...beds.builders.values());
    return builders.filter((b): b is PartBuilder => b !== null && !b.isEmpty);
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
/** Perimeter (m) of a house that gets full-density planting; larger houses are planted more sparsely. */
const PLANTED_PERIMETER = 30;
/** Triangles the whole part aims to stay under, and what planting typically takes of it. */
const PROPS_BUDGET = 28000;
const PLANTING_TYPICAL = 13000;
/** Kept back from the planting cap for the grass tufts sown afterwards. */
const TUFT_RESERVE = 1800;
/** How far a grass tuft's leaning blades can reach from its root. */
const TUFT_REACH = 0.17;

/** Lanterns are modelled at a real-world size, then scaled up a little for the chunky style. */
const LANTERN_SCALE = 1.3;
const LANTERN_HEIGHT = 0.37 * LANTERN_SCALE;
/** Half the width a wall lantern (with its bracket) takes on the wall face. */
const LANTERN_HALF = 0.17;

const IRON = '#3d3834';
const GLOW = '#ffe0a3';
const DIRT = '#97815f';
/** Gravel and earth showing in the joints between flagstones. */
const GRAVEL = '#857a68';
/**
 * The path's edges melt into the lawn: the viewer's ground is ≈ #7f9c52
 * (drifting lusher / drier); a touch lighter here because the viewer
 * darkens ground-level mortar a little ("damp").
 */
const PATH_EDGE = '#83a055';
const GRASS_ROOT = '#789a4b';
const GRASS_TIP = '#a6c463';
/** Path stones: the palette's stone, greyed and a little darker so the path does not glare. */
const PATH_GREY = '#8c897f';
const LEAVES = ['#55843d', '#659247', '#4d7a3a', '#76a04d', '#5f8a4a'];
const TERRACOTTA = '#c4704a';
const SOIL = '#5b4434';
const END_GRAIN = '#d9ba8c';
const SPLIT_WOOD = '#c39468';
const BARK = '#644935';
const WEATHERED = '#9c907f';
const FLOWER_EYE = new THREE.Color('#e3a92e');

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
  /** Wall-mounted things (the lantern) that climbing plants must keep well away from. */
  readonly keepClear: { wall: WallSpec; u0: number; u1: number }[] = [];
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
    for (const wall of this.walls) this.zones.set(wall, wall.openings.map((o) => openingZone(o, layout)));
    // Windows of the storeys above count too (in the ground wall's u): tall
    // things against the wall (a lean-to, a climber) must stay below their
    // sills and flower boxes. Jettied upper walls stand further out, but they
    // run parallel, so projecting onto the ground wall's axis is enough.
    for (const s of layout.storeys.slice(1)) {
      for (const upper of s.walls) {
        const ground = this.walls.find((w) => w.side === upper.side);
        if (!ground) continue;
        for (const o of upper.openings) {
          const z = openingZone(o, layout);
          const a = this.alongWall(ground, wallPoint(upper, z.u0, 0, 0));
          const c = this.alongWall(ground, wallPoint(upper, z.u1, 0, 0));
          this.zones.get(ground)?.push({ u0: Math.min(a, c), u1: Math.max(a, c), yLow: z.yLow });
        }
      }
    }
  }

  /** u of a world point projected onto a wall's axis. */
  alongWall(wall: WallSpec, p: { x: number; z: number }): number {
    return (p.x - wall.start.x) * wall.dir.x + (p.z - wall.start.z) * wall.dir.z;
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

  /** Outward normals of the ground-floor walls that (x, z) stands in front of, within `reach`. */
  wallNormalsNear(x: number, z: number, reach = 0.6): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    for (const wall of this.walls) {
      const dx = x - wall.start.x;
      const dz = z - wall.start.z;
      const u = dx * wall.dir.x + dz * wall.dir.z;
      const w = dx * wall.normal.x + dz * wall.normal.z;
      // Near a corner both walls count.
      if (w > -0.05 && w < reach && u > -0.3 && u < wall.length + 0.3) out.push(wall.normal);
    }
    return out;
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
function openingZone(o: Opening, layout: HouseLayout): WallZone {
  if (o.kind === 'door') {
    // Nothing stands in front of the doorway or under its hood.
    const hood = layout.doorHood;
    return { u0: Math.min(o.surround.u0, hood.u0) - 0.04, u1: Math.max(o.surround.u1, hood.u1) + 0.04, yLow: -Infinity };
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
 * Little open flower facing +y, radius 1: `petals` rounded tips around a
 * slightly sunken centre (y = 0.12), the rim at y ≈ 0.2, tapering to a narrow
 * base at y = -0.2 that hides in the foliage (no bottom cap). 5 × petals
 * triangles.
 */
function flowerGeometry(petals: number): THREE.BufferGeometry {
  const n = petals * 2; // rim alternates petal tip / notch
  const pos: number[] = [0, 0.12, 0];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : 0.68; // shallow notches: rounded petals, not a star
    pos.push(Math.cos(a) * r, i % 2 === 0 ? 0.22 : 0.18, Math.sin(a) * r);
  }
  for (let i = 0; i < petals; i++) {
    const a = ((i * 2 + 1) / n) * Math.PI * 2; // under the notches
    pos.push(Math.cos(a) * 0.3, -0.2, Math.sin(a) * 0.3);
  }
  const rim = (i: number) => 1 + (i % n);
  const base = (j: number) => 1 + n + (j % petals);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(0, rim(i + 1), rim(i)); // face
  for (let j = 0; j < petals; j++) {
    // Underside of petal j (tip 2j between notches 2j-1 and 2j+1) down to the base ring.
    const tip = 2 * j;
    idx.push(rim(tip), rim(tip + 1), base(j)); // tip → next notch → base under that notch
    idx.push(rim(tip + n - 1), rim(tip), base(j + petals - 1)); // previous notch → tip → base under it
    idx.push(rim(tip), base(j), base(j + petals - 1));
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
const FLOWER = flowerGeometry(5);
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

  // Field stones are greyer and a touch darker than the dressed stone of the
  // house, so the path sits in the lawn instead of glaring pale pink-beige.
  const stone = `#${mix(site.palette.stone, PATH_GREY, 0.45).multiplyScalar(0.8).getHexString()}`;
  if (style === 'stepping') {
    addSteppingStones(b, rng, frames, { first: 0.3, spacing: [0.55, 0.65], size: [0.22, 0.28], lateral: 0.06, stone });
  } else if (style === 'trail') {
    addPathRibbon(b, rng, frames, new THREE.Color(DIRT));
    addSteppingStones(b, rng, frames, { first: 0.3, spacing: [0.65, 0.95], size: [0.18, 0.24], lateral: 0.12, stone });
    addPebbles(b, rng, frames, stone);
  } else {
    // Dark gravel joints between the flags.
    addPathRibbon(b, rng, frames, mix(GRAVEL, DIRT, 0.25));
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
    const spread = 1 + 0.3 * smoothstep(0.68, 1, s); // and spreading out as it fades into the lawn
    const wobble = 1 + 0.06 * Math.sin(s * 9 + phase);
    frames.push({
      x: origin.x + wall.dir.x * p.x + wall.normal.x * p.y,
      z: origin.z + wall.dir.z * p.x + wall.normal.z * p.y,
      tx: wall.dir.x * t.x + wall.normal.x * t.y,
      tz: wall.dir.z * t.x + wall.normal.z * t.y,
      hw: halfWidth * flare * spread * wobble,
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
  const grass = new THREE.Color(PATH_EDGE);
  const phL = rng.range(0, 10);
  const phR = rng.range(0, 10);
  const rows: Vertex[][] = frames.map((f, i) => {
    const edgeL = 1 + 0.09 * Math.sin(i * 0.8 + phL) + rng.jitter(0.05);
    const edgeR = 1 + 0.09 * Math.sin(i * 0.7 + phR) + rng.jitter(0.05);
    // Towards the far end the gravel thins to a narrow, fading strip while
    // the stones on it scatter wider: the path dissolves into the lawn.
    const t = i / (frames.length - 1);
    const fade = smoothstep(0.62, 1, t);
    const thin = 1 - 0.75 * smoothstep(0.68, 1, t);
    return lanes.map((k) => {
      const edge = Math.abs(k) === 1;
      const lat = k * f.hw * thin * (edge ? (k > 0 ? edgeL : edgeR) : 1);
      const p = beside(f, lat);
      const c = vary(base, rng, 0.035, 0.03, 0.005);
      if (k === 0) c.multiplyScalar(0.95); // the worn centre track
      c.lerp(grass, Math.min(1, (edge ? 0.85 : Math.abs(k) > 0 ? 0.12 : 0) + fade * 0.7));
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
  const gap = 0.03; // half the joint: wide enough for the dark gravel to read
  let d = 0.07; // first row a hand's width off the bottom step
  while (d < total - 0.2) {
    const depth = rng.range(0.3, 0.42);
    const f = frameAt(frames, d + depth / 2);
    const hw = f.hw * 0.9;
    // Towards the far end the flags thin out, shrink and drift apart into the grass.
    const fadeOut = smoothstep(0.6, 1, d / total);
    const cells = hw * 2 > 0.95 ? rng.int(2, 3) : hw * 2 > 0.55 ? rng.int(1, 2) : 1;
    // Random cut positions across the path.
    const cuts = [-hw];
    for (let k = 1; k < cells; k++) cuts.push(-hw + ((2 * hw) / cells) * (k + rng.jitter(0.25)));
    cuts.push(hw);
    for (let k = 0; k < cells; k++) {
      if (rng.chance(fadeOut * 0.7)) continue;
      const shrink = 1 - fadeOut * rng.range(0.15, 0.35);
      const cw = ((cuts[k + 1] - cuts[k]) / 2 - gap) * shrink;
      const cd = (depth / 2 - gap) * shrink;
      if (cw < 0.08) continue;
      const lat = (cuts[k] + cuts[k + 1]) / 2 + rng.jitter(0.015 + fadeOut * 0.05);
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
      if (site.grassFits(p.x, p.z)) addTuft(b, rng, p.x, p.z, rng.range(0.8, 1.15), site.wallNormalsNear(p.x, p.z));
    }
  }
  const { stoop } = site.layout;
  for (const u of [stoop.u0 - 0.14, stoop.u1 + 0.14]) {
    const p = wallPoint(site.front, u, 0, stoop.w1 + rng.range(-0.05, 0.08));
    // Upright-ish so no blade leans into the steps.
    if (site.grassFits(p.x, p.z)) addTuft(b, rng, p.x, p.z, rng.range(0.9, 1.2), [site.front.normal], 0.25);
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
  const { door, doorHood: hood } = site.layout;
  const dc = (door.u0 + door.u1) / 2;
  const reach = 0.32; // w of the lantern's axis
  // Arm level with the door head, but under the ceiling the layout keeps for
  // the hood (joist ends, storey band, eave); lower still when an eave or a
  // jetty comes down close in front of the wall.
  const below = wallPoint(wall, dc, 0, reach + 0.12);
  const head = site.headroomAt(below.x, below.z);
  const armY = Math.min(door.y1 - 0.02, hood.y1 - 0.1, wall.y1 - 0.22, head - 0.05);
  const fitsWall = armY - LANTERN_HEIGHT > door.y0 + 1.0;

  if (fitsWall) {
    const sides = rng.chance(0.5) ? [1, -1] : [-1, 1];
    const gap = rng.range(0.05, 0.1);
    for (const side of sides) {
      // Just outside the hood zone (and the door surround), with a hand's gap.
      const edge = side > 0 ? Math.max(hood.u1, door.surround.u1) : Math.min(hood.u0, door.surround.u0);
      const lu = edge + side * (LANTERN_HALF + gap);
      if (!lanternClear(wall, lu, armY, hood)) continue;
      addWallBracket(b, rng, wallMatrix(wall, lu, armY, 0), reach);
      addLantern(b, rng, wallMatrix(wall, lu, armY - 0.012, reach));
      site.addZone(wall, { u0: lu - 0.2, u1: lu + 0.2, yLow: armY - LANTERN_HEIGHT - 0.1 });
      site.keepClear.push({ wall, u0: lu - 0.2, u1: lu + 0.2 });
      b.explode = wallExplode(wall, OUTWARD.props);
      return b;
    }
  }
  return buildLanternPost(site, rng, b);
}

/**
 * True when a wall lantern at u = lu (arm at armY) stays clear of the wall's
 * openings and of the zone the layout reserves above the door for its hood.
 */
function lanternClear(wall: WallSpec, lu: number, armY: number, hood: HouseLayout['doorHood']): boolean {
  const r = { u0: lu - LANTERN_HALF, u1: lu + LANTERN_HALF, y0: armY - LANTERN_HEIGHT - 0.04, y1: armY + 0.08 };
  if (r.u0 < 0.3 || r.u1 > wall.length - 0.3) return false;
  const pad = 0.03;
  if (r.u0 < hood.u1 + pad && r.u1 > hood.u0 - pad && r.y1 > hood.y0 - pad && r.y0 < hood.y1 + pad) return false;
  return wall.openings.every((o) => {
    if (o.kind === 'door') return r.u0 >= o.surround.u1 + pad || r.u1 <= o.surround.u0 - pad;
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
// Woodshed: a little lean-to against a gable wall
// ---------------------------------------------------------------------------

type ShedKind = 'open' | 'closed';

/**
 * A lean-to, in the frame of its wall: x along the wall from the shed's
 * centre, y up, z = w (outward from the wall face).
 */
interface Shed {
  /** Open front showing stacked firewood, or planked shut with a door. */
  kind: ShedKind;
  /** Across the corner posts (outer faces). */
  width: number;
  /** Outer face of the front posts. */
  depth: number;
  pitch: number;
  /** Roof overhang past the side walls and past the front posts. */
  sideOver: number;
  frontOver: number;
  /** Underside of the roof deck where it meets the wall (z = SHED_BACK). */
  backY: number;
}

/** z where the roof deck meets the wall: in front of the stones (≤ +0.07) and beams. */
const SHED_BACK = 0.09;
const SHED_DECK = 0.03;
const SHED_RAFTER = 0.07;
const SHED_BEAM = 0.11;
/** Lowest clear height under the front beam. */
const SHED_CLEAR_MIN = 1.45;
/** The flashing against the wall: in front of every wall layer, as props on the wall must be. */
const SHED_FLASH_W = 0.08;

/** Small tiles for the lean-to roof, a bit smaller than the main roof's but of the same covering. */
const SHED_TILES: Record<RoofCovering, { w: number; len: number; gauge: number; th: number; irregular: boolean }> = {
  beaver: { w: 0.2, len: 0.31, gauge: 0.14, th: 0.018, irregular: false },
  fish: { w: 0.21, len: 0.3, gauge: 0.135, th: 0.017, irregular: false },
  slate: { w: 0.23, len: 0.32, gauge: 0.145, th: 0.014, irregular: true },
  shingle: { w: 0.16, len: 0.31, gauge: 0.135, th: 0.02, irregular: true },
};

/** Height of the deck underside at z (before the sag). */
function shedUnderside(s: Shed, z: number): number {
  return s.backY - (z - SHED_BACK) * Math.tan(s.pitch);
}

/** Highest point of the shed: the flashing turned up the wall above the top course. */
function shedTop(s: Shed): number {
  return s.backY + 0.19;
}

/** `base` resized: depth, pitch (degrees) and the clear height under its front beam. */
function shedWith(base: Shed, depth: number, pitchDeg: number, clear: number): Shed {
  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  // Front beam under the rafters on the posts' centre line (z = depth - 0.05).
  const beamTop = clear + SHED_BEAM;
  const backY = beamTop + SHED_RAFTER / Math.cos(pitch) + (depth - 0.05 - SHED_BACK) * Math.tan(pitch);
  return { ...base, depth, pitch, backY };
}

/** The biggest version of `base` (flatter, lower, shallower if need be) whose top stays under `limit`. */
function fitShed(base: Shed, clear: number, limit: number): Shed | null {
  const deg0 = THREE.MathUtils.radToDeg(base.pitch);
  for (const depth of [base.depth, Math.max(1.0, base.depth * 0.85), 1.0]) {
    for (const c of [clear, (clear + SHED_CLEAR_MIN) / 2, SHED_CLEAR_MIN]) {
      for (let deg = deg0; deg >= 13.9; deg -= 3) {
        const s = shedWith(base, depth, deg, c);
        if (shedTop(s) <= limit) return s;
      }
    }
  }
  return null;
}

/**
 * About half the houses get a little lean-to woodshed against a gable wall:
 * preferably a blank stretch (no ground-floor windows), on the chimney side.
 * Its roof stays below every window sill / flower box above it, the storey
 * band and the eave; it never covers a window, the door, the steps or the
 * path. Null when the house doesn't get one (or it doesn't fit).
 */
function buildWoodshed(site: Site, rng: Rng): PartBuilder | null {
  // Not every gable has room for one: asking more often lands near half the houses.
  if (!rng.chance(0.68)) return null;
  const { layout } = site;
  const ground = layout.storeys[0];
  const chimneySide = layout.chimney ? layout.params.chimneySide : null;
  const walls = site.walls
    .filter((w) => w.isGable)
    .map((w) => {
      const blank = w.openings.every((o) => o.kind === 'attic');
      return { w, score: (blank ? 2 : 0) + (w.side === chimneySide ? 1 : 0) + rng.range(0, 0.9) };
    })
    .sort((a, b) => b.score - a.score)
    .map((e) => e.w);
  const base: Shed = {
    kind: rng.chance(0.65) ? 'open' : 'closed',
    width: rng.range(1.5, 3.0),
    depth: rng.range(1.0, 1.6),
    pitch: THREE.MathUtils.degToRad(rng.range(17, 26)),
    sideOver: rng.range(0.1, 0.15),
    frontOver: rng.range(0.16, 0.24),
    backY: 0,
  };
  const clear = rng.range(1.55, 1.8);
  // Below the top plate / storey band, or the eave of a cottage.
  const ceiling = ground.y1 - 0.25;
  for (let attempt = 0; attempt < 4; attempt++) {
    const tallest = fitShed(base, clear, ceiling);
    if (!tallest) return null;
    const len = base.width + 2 * base.sideOver;
    for (const wall of walls) {
      // Free stretches, kept a hand's breadth from the shutters / flower boxes of a window beside them.
      const spans = site
        .freeSpans(wall, shedTop(tallest) + 0.05, 0.05)
        .map(([a, b]): [number, number] => [a > 0.06 ? a + 0.08 : a, b < wall.length - 0.06 ? b - 0.08 : b])
        .filter(([a, b]) => b - a >= len);
      for (let i = 0; i < 6 && spans.length; i++) {
        const [a, c] = rng.pick(spans);
        // Usually tucked into a corner or against a window, the way sheds get built.
        const u0 = rng.chance(0.75) ? (rng.chance(0.5) ? a : c - len) : a + rng.range(0, c - a - len);
        const u1 = u0 + len;
        const reach = (d: number) => d + base.frontOver + 0.03;
        let fp = site.wallFootprint(wall, u0, u1, PLINTH_REACH + 0.01, reach(tallest.depth));
        if (!site.fits(fp, 0.06)) continue;
        const limit = Math.min(ceiling, site.heightLimit(wall, u0 - 0.1, u1 + 0.1), site.headroom(fp));
        const shed = fitShed(base, clear, limit);
        if (!shed) continue;
        // A planked shed with a door needs some width, or it reads as a privy.
        if (shed.width < 1.95) shed.kind = 'open';
        fp = site.wallFootprint(wall, u0, u1, PLINTH_REACH + 0.01, reach(shed.depth));
        site.claim(fp, 'solid');
        site.addZone(wall, { u0, u1, yLow: -Infinity });
        const b = new PartBuilder('props:woodshed');
        b.explode = wallExplode(wall, OUTWARD.props);
        const uc = (u0 + u1) / 2;
        addShed(b, rng, site, wall, uc, shed);
        site.anchorFront(wall, u0, u1, reach(shed.depth));
        if (shed.kind === 'open' ? rng.chance(0.75) : rng.chance(0.3)) {
          addChoppingBlock(b, rng, site, wall, uc, shed.width * 0.7, reach(shed.depth) - WALL_GAP - 0.1);
        }
        return b;
      }
    }
    base.width = Math.max(1.5, base.width * 0.82);
    if (attempt === 1) base.depth = Math.min(base.depth, 1.2);
  }
  return null;
}

/** Build the lean-to `s` whose centre is at u = uc on `wall`. */
function addShed(b: PartBuilder, rng: Rng, site: Site, wall: WallSpec, uc: number, s: Shed): void {
  const pal = site.palette;
  const m = wallMatrix(wall, uc, 0, 0);
  const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => mul(m, mat4(x, y, z, rx, ry, rz));
  const cos = Math.cos(s.pitch);
  const hw = s.width / 2;
  const zPost = s.depth - 0.05;
  const beamTop = shedUnderside(s, zPost) - SHED_RAFTER / cos;
  const clear = beamTop - SHED_BEAM;
  const halfRoof = hw + s.sideOver;
  // Roof slope frame: x along the wall, y out of the roof, z down the slope
  // from where the deck meets the wall; S = slope length to the eave edge.
  const S = (s.depth + s.frontOver - SHED_BACK) / cos;
  // Hand-made sag: the front edge dips in the middle (less with a middle post).
  const midPost = s.width > 2.3;
  const sag = rng.range(0.025, 0.045) * (midPost ? 0.5 : 1);
  const dip = (x: number) => sag * Math.max(0, 1 - (x / halfRoof) ** 2);
  const slope = at(0, s.backY, SHED_BACK, s.pitch);
  /** Slope frame of the column at x, turned about the wall line so it sags. */
  const col = (x: number) => mul(slope, mat4(x, 0, 0, dip(x) / S, 0, 0));
  const timber = vary(pal.timber, rng, 0.04, 0.03, 0.01);
  const piece = () => vary(timber, rng, 0.035, 0.025, 0.006);

  // Posts on flat stones at the front, against the wall at the back.
  const frontXs = midPost ? [-hw + 0.05, rng.jitter(0.05), hw - 0.05] : [-hw + 0.05, hw - 0.05];
  for (const x of frontXs) {
    rbox(b, 'timber', piece(), 0.1, clear, 0.1, at(x, clear / 2, zPost, rng.jitter(0.012), 0, rng.jitter(0.015)), 0.016);
    b.add(slabGeometry(stoneOutline(rng, 0.1, 0.09), 0.035, 0.02), 'stone', stoneColor(rng, pal.stone), at(x, 0, zPost, 0, rng.range(0, 6), 0));
  }
  const ledgerTop = shedUnderside(s, 0.12) - SHED_RAFTER / cos;
  for (const x of [-hw + 0.05, hw - 0.05]) {
    const h = shedUnderside(s, 0.16) - SHED_RAFTER / cos;
    rbox(b, 'timber', piece(), 0.1, h, 0.1, at(x, h / 2, 0.165), 0.016);
  }
  rbox(b, 'timber', piece(), 2 * halfRoof - 0.06, 0.1, 0.08, at(0, ledgerTop - 0.05, 0.12), 0.015); // ledger on the wall
  rbox(b, 'timber', piece(), 2 * halfRoof - 0.02, SHED_BEAM, 0.1, at(0, beamTop - SHED_BEAM / 2, zPost, 0, 0, rng.jitter(0.006)), 0.016);

  // Rafters, deck boards, barge boards and a fascia that sags with the deck.
  const nR = Math.max(3, Math.round(s.width / 0.55) + 1);
  for (let i = 0; i < nR; i++) {
    const x = -hw + 0.05 + ((s.width - 0.1) * i) / (nR - 1);
    const len = S - 0.06;
    rbox(b, 'timber', piece(), 0.06, SHED_RAFTER, len, mul(col(x), mat4(0, -SHED_RAFTER / 2, 0.03 + len / 2)), 0.012);
  }
  const deck = mix(pal.wood, '#3a2a1e', 0.3);
  const nB = Math.max(4, Math.round((2 * halfRoof) / 0.2));
  const bw = (2 * halfRoof) / nB;
  for (let i = 0; i < nB; i++) {
    const x = -halfRoof + bw * (i + 0.5);
    const edge = i === 0 || i === nB - 1;
    rbox(b, 'wood', vary(deck, rng, 0.05, 0.03, 0.01), bw - 0.006, SHED_DECK, S, mul(col(x), mat4(0, SHED_DECK / 2, S / 2)), edge ? 0.008 : 0);
  }
  for (const sx of [-1, 1]) {
    const len = S - 0.025;
    rbox(b, 'timber', piece(), 0.03, 0.14, len, mul(slope, mat4(sx * (halfRoof + 0.015), -0.025, 0.04 + len / 2)), 0.01);
  }
  const fasciaW = halfRoof + 0.03;
  for (const sx of [-1, 1]) {
    // From the corner (no dip) to the middle (full dip): a slightly kinked old board.
    const fm = mul(slope, mat4(sx * (fasciaW / 2), -0.015 - dip(0) / 2, S + 0.015, 0, 0, sx * Math.atan2(dip(0), fasciaW)));
    rbox(b, 'timber', piece(), fasciaW + 0.02, 0.12, 0.03, fm, 0.01);
  }
  addShedTiles(b, rng, site, col, halfRoof, S);
  // Lead flashing: a roll over the top course, turned up the wall.
  const lead = vary(mix(pal.mortar, '#6b7073', 0.55), rng, 0.03, 0.02, 0);
  rbox(b, 'mortar', lead, 2 * halfRoof + 0.02, 0.05, 0.15, mul(slope, mat4(0, SHED_DECK + 0.06, 0.085)), 0.02);
  const flashY0 = s.backY + 0.03;
  const flashY1 = shedTop(s) - 0.01;
  rbox(b, 'mortar', lead, 2 * halfRoof + 0.02, flashY1 - flashY0, 0.016, at(0, (flashY0 + flashY1) / 2, SHED_FLASH_W + 0.008), 0.006);

  // Weathered plank walls on both sides, cut to the slope of the roof.
  const boards = mix(pal.wood, WEATHERED, rng.range(0.3, 0.5));
  const z0 = 0.11;
  for (const sx of [-1, 1]) {
    const x = sx * (hw + 0.0125);
    const n = Math.max(4, Math.round((s.depth - z0) / 0.15));
    const pw = (s.depth - z0) / n;
    for (let i = 0; i < n; i++) {
      const za = z0 + pw * i + 0.003;
      const top = (z: number) => shedUnderside(s, z) - 0.004 - (dip(x) * (z - SHED_BACK)) / (S * cos) + rng.jitter(0.004);
      b.add(plankBetween(x, 0.025, za, za + pw - 0.006, 0.03, top), 'wood', vary(boards, rng, 0.06, 0.04, 0.01), m);
    }
  }

  if (s.kind === 'closed') {
    addShedFront(b, rng, pal, m, s, clear, frontXs, boards);
  } else {
    // Trodden earth floor, firewood stacked to the front behind the posts.
    rbox(b, 'mortar', vary('#5e4d3c', rng, 0.04, 0.03, 0.01), s.width - 0.04, 0.012, s.depth - 0.14, at(0, 0.004, (0.11 + s.depth) / 2));
    const stackDepth = rng.range(0.38, 0.44);
    const sm = at(0, 0, s.depth - 0.16 - stackDepth);
    addWoodStack(b, rng, sm, s.width - 0.24, stackDepth, Math.min(clear - 0.12, clear * rng.range(0.6, 0.85)));
  }
}

/**
 * A plank (thickness t across x) from z0 to z1, its foot at y0 and its top
 * cut to `top(z)`, built directly in the frame it will be added with.
 */
function plankBetween(x: number, t: number, z0: number, z1: number, y0: number, top: (z: number) => number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(t, 1, 1);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const yTop = [top(z0), top(z1)];
  for (let i = 0; i < pos.count; i++) {
    const back = pos.getZ(i) < 0;
    pos.setXYZ(i, x + pos.getX(i), pos.getY(i) > 0 ? yTop[back ? 0 : 1] : y0, back ? z0 : z1);
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/** Planked front of a closed shed with a ledged-and-braced door between the posts. */
function addShedFront(b: PartBuilder, rng: Rng, pal: Palette, m: THREE.Matrix4, s: Shed, clear: number, posts: number[], boards: THREE.Color): void {
  const at = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => mul(m, mat4(x, y, z, rx, ry, rz));
  const hw = s.width / 2;
  const zF = s.depth + 0.0125;
  // The door sits in the widest bay between two posts.
  let bay = [posts[0], posts[1]];
  for (let i = 1; i + 1 < posts.length; i++) if (posts[i + 1] - posts[i] > bay[1] - bay[0]) bay = [posts[i], posts[i + 1]];
  const doorW = Math.min(0.78, bay[1] - bay[0] - 0.22);
  const room = Math.max(0, (bay[1] - bay[0] - doorW) / 2 - 0.11);
  const dx = (bay[0] + bay[1]) / 2 + rng.jitter(room);
  const jamb = 0.075;
  const d0 = dx - doorW / 2 - jamb;
  const d1 = dx + doorW / 2 + jamb;
  const top = clear - 0.005;
  const n = Math.max(6, Math.round(s.width / 0.15));
  const pw = s.width / n;
  for (let i = 0; i < n; i++) {
    const a = -hw + pw * i;
    const c = a + pw;
    // Cut the boards around the door opening.
    const pieces: [number, number][] = c <= d0 || a >= d1 ? [[a, c]] : a < d0 ? [[a, d0]] : c > d1 ? [[d1, c]] : [];
    for (const [p0, p1] of pieces) {
      if (p1 - p0 < 0.03) continue;
      const h = top - 0.03 + rng.jitter(0.006);
      rbox(b, 'wood', vary(boards, rng, 0.06, 0.04, 0.01), p1 - p0 - 0.006, h, 0.025, at((p0 + p1) / 2, 0.03 + h / 2, zF));
    }
  }
  // Jambs and head.
  const frame = vary(pal.timber, rng, 0.04, 0.03, 0.01);
  for (const x of [d0 + jamb / 2, d1 - jamb / 2]) rbox(b, 'timber', frame, jamb, top - 0.03, 0.035, at(x, 0.03 + (top - 0.03) / 2, zF + 0.005), 0.01);
  // The door leaf: vertical boards, two ledges and a brace, strap hinges and a latch.
  const painted = rng.chance(0.4);
  const leafColor = painted ? mix(pal.shutter, WEATHERED, 0.25) : mix(pal.wood, WEATHERED, 0.2);
  const leafH = top - 0.08;
  const nb = Math.max(3, Math.round(doorW / 0.15));
  for (let i = 0; i < nb; i++) {
    const x = dx - doorW / 2 + (doorW * (i + 0.5)) / nb;
    rbox(b, 'wood', vary(leafColor, rng, 0.05, 0.03, 0.01), doorW / nb - 0.008, leafH, 0.025, at(x, 0.05 + leafH / 2, zF + 0.004), 0.004);
  }
  const ledgeY = [0.05 + leafH * 0.2, 0.05 + leafH * 0.8];
  for (const y of ledgeY) rbox(b, 'wood', vary(leafColor, rng, 0.04, 0.03, 0.01), doorW - 0.07, 0.09, 0.025, at(dx, y, zF + 0.028), 0.008);
  const hingeSide = rng.chance(0.5) ? -1 : 1;
  const braceLen = Math.hypot(doorW - 0.14, ledgeY[1] - ledgeY[0] - 0.09);
  const braceA = Math.atan2(ledgeY[1] - ledgeY[0] - 0.09, doorW - 0.14) * -hingeSide;
  rbox(b, 'wood', vary(leafColor, rng, 0.04, 0.03, 0.01), braceLen, 0.08, 0.022, at(dx, (ledgeY[0] + ledgeY[1]) / 2, zF + 0.027, 0, 0, braceA), 0.008);
  const iron = vary(IRON, rng, 0.03, 0.02, 0);
  for (const y of ledgeY) {
    const hx = dx + hingeSide * (doorW / 2 - doorW * 0.28);
    rbox(b, 'metal', iron, doorW * 0.56, 0.035, 0.01, at(hx, y, zF + 0.045), 0.004);
  }
  const lx = dx - hingeSide * (doorW / 2 - 0.09);
  b.add(new THREE.TorusGeometry(0.03, 0.006, 4, 10), 'metal', iron, at(lx, 0.05 + leafH * 0.52, zF + 0.05));
  rbox(b, 'metal', iron, 0.03, 0.05, 0.012, at(lx, 0.05 + leafH * 0.52 + 0.03, zF + 0.024), 0.004);
}

/**
 * Small tiles of the main roof's covering and colours on the lean-to, laid
 * in courses from the eave up to the wall, each course's tails resting on
 * the heads of the one below. `col(x)` is the (sagging) slope frame at x.
 */
function addShedTiles(b: PartBuilder, rng: Rng, site: Site, col: (x: number) => THREE.Matrix4, halfRoof: number, S: number): void {
  const { covering } = site.layout.roof;
  const t = SHED_TILES[covering];
  // A little larger on very big houses (seen from further away).
  const k = 1 / Math.sqrt(Math.max(0.6, site.layout.detail));
  const tw = t.w * k;
  const len = t.len * k;
  const gauge = t.gauge * k;
  const tilt = Math.asin(Math.min(0.5, (t.th + 0.004) / gauge));
  const geo = shedTileGeometry(covering);
  const base = new THREE.Color(site.palette.roof);
  const moss = new THREE.Color('#66734a');
  const gap = 0.006;
  let course = 0;
  for (let tail = S + 0.05; ; tail -= gauge, course++) {
    const head = Math.max(0.02, tail - len);
    const L = tail - head;
    if (L < 0.07) break;
    // The eave course lies flatter, its tails resting on the fascia.
    const a = course === 0 ? Math.asin(Math.min(0.3, 0.022 / L)) : tilt;
    const cells: [number, number][] = [];
    if (t.irregular) {
      for (let x = -halfRoof; x < halfRoof - 0.04; ) {
        const w = tw * rng.range(0.7, 1.3);
        cells.push([x, Math.min(halfRoof, x + w)]);
        x += w;
      }
    } else {
      for (let x = -halfRoof - (course % 2 ? tw / 2 : 0); x < halfRoof - 0.04; x += tw) {
        cells.push([Math.max(-halfRoof, x), Math.min(halfRoof, x + tw)]);
      }
    }
    for (const [x0, x1] of cells) {
      if (x1 - x0 < 0.05) continue;
      const xc = (x0 + x1) / 2;
      const c = vary(base, rng, 0.035, 0.03, 0.007);
      if (rng.chance(0.07)) c.lerp(moss, rng.range(0.2, 0.4));
      const tm = mul(col(xc), mat4(0, SHED_DECK, head, -a + rng.jitter(0.015), rng.jitter(0.02), rng.jitter(0.012), x1 - x0 - gap, t.th, L));
      b.add(geo, 'roof', c, tm);
    }
  }
}

const shedTileCache = new Map<RoofCovering, THREE.BufferGeometry>();

/**
 * Unit tile of a covering, flat-shaded: x ∈ [-0.5, 0.5] across, y ∈ [0, 1]
 * thick, z from the head (0) to the tail (1). Top and edges only (the head
 * edge and the underside are always hidden).
 */
function shedTileGeometry(kind: RoofCovering): THREE.BufferGeometry {
  let g = shedTileCache.get(kind);
  if (g) return g;
  // Outline in (x, z): head corners, then the tail from +x round to -x.
  const pts: [number, number][] = [
    [-0.5, 0],
    [0.5, 0],
  ];
  if (kind === 'beaver' || kind === 'fish') {
    const tailH = kind === 'fish' ? 0.42 : 0.24;
    const e = kind === 'fish' ? 1 : 2 / 2.6;
    for (let i = 0; i <= 5; i++) {
      const phi = (i / 5) * Math.PI;
      const c = Math.cos(phi);
      const sn = Math.sin(phi);
      pts.push([0.5 * Math.sign(c) * Math.abs(c) ** e, 1 - tailH + tailH * Math.abs(sn) ** e]);
    }
  } else {
    const r = kind === 'slate' ? 0.14 : 0.05;
    pts.push([0.5, 1 - r], [0.5 - r * 0.7, 1], [-0.5 + r * 0.7, 1], [-0.5, 1 - r]);
  }
  const pos: number[] = [];
  const v = (x: number, y: number, z: number) => pos.push(x, y, z);
  const n = pts.length;
  // Top: a fan, wound to face +y.
  for (let i = 1; i + 1 < n; i++) {
    v(pts[0][0], 1, pts[0][1]);
    v(pts[i + 1][0], 1, pts[i + 1][1]);
    v(pts[i][0], 1, pts[i][1]);
  }
  // Edges, facing outwards; skip the head edge (pts[0] → pts[1]).
  for (let i = 1; i < n; i++) {
    const [ax, az] = pts[i];
    const [cx, cz] = pts[(i + 1) % n];
    v(ax, 0, az);
    v(cx, 0, cz);
    v(cx, 1, cz);
    v(ax, 0, az);
    v(cx, 1, cz);
    v(ax, 1, az);
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  shedTileCache.set(kind, g);
  return g;
}

// ---------------------------------------------------------------------------
// Planting: shrubs, flowers and grass along the walls
// ---------------------------------------------------------------------------

/** One builder per ground-floor wall for everything that grows there (explodes with its wall). */
class Beds {
  readonly builders = new Map<WallSpec, PartBuilder>();

  constructor(site: Site) {
    for (const wall of site.walls) {
      const b = new PartBuilder(`props:plants:${wall.side}`);
      b.explode = wallExplode(wall, OUTWARD.props);
      this.builders.set(wall, b);
    }
  }

  get(wall: WallSpec): PartBuilder {
    return this.builders.get(wall)!;
  }

  get triangles(): number {
    let n = 0;
    for (const b of this.builders.values()) n += b.triangles;
    return n;
  }
}

type ShrubShape = 'round' | 'ovoid' | 'mound';
type BedPlant = ShrubShape | 'flowers';

/** A plant picked for a spot: what it is and how big (along the wall, height, outward). */
interface PlantPick {
  kind: BedPlant;
  w: number;
  h: number;
  d: number;
}

/**
 * Walk along every ground-floor wall planting small groups (a lead shrub
 * with one or two companions nestled against it) with stretches of open lawn
 * between them, each plant low enough for the windows above it; then
 * sprinkle grass tufts along the base and at the feet of everything placed.
 */
function buildPlanting(site: Site, beds: Beds, rng: Rng, budget: number): void {
  // When the rest already took much of the budget, plant more sparsely; never past it.
  const share = THREE.MathUtils.clamp((budget - beds.triangles) / PLANTING_TYPICAL, 0.55, 1);
  const cap = budget - TUFT_RESERVE;
  const lush = rng.range(0.6, 1);
  // Big houses get wider gaps and fewer tufts so the part stays inside its
  // triangle budget (they are seen from further away, so it reads the same).
  const perimeter = site.walls.reduce((s, w) => s + w.length, 0);
  const { detail } = site.layout;
  const extraGap = Math.max(0, perimeter / PLANTED_PERIMETER - 1) * 0.9 + (1 - detail) * 1.4 + (1 - share) * 1.5;
  const density = detail * share * Math.min(1, PLANTED_PERIMETER / perimeter);
  const flowers = flowerColors(site.palette);
  // The front first (it matters most), the back last.
  const order = ['front', 'right', 'left', 'back'].map((side) => site.walls.find((w) => w.side === side)!);
  for (const wall of order) {
    const sideFactor = wall.side === 'front' ? 1.25 : wall.side === 'back' ? 0.7 : 0.9;
    plantAlongWall(beds, rng, site, wall, lush * sideFactor * rng.range(0.8, 1.2), extraGap, flowers, cap);
  }
  for (const wall of site.walls) {
    const b = beds.get(wall);
    const count = Math.round(wall.length * 2.4 * (0.6 + lush * 0.6) * density);
    for (let i = 0; i < count; i++) {
      const u = rng.range(-0.05, wall.length + 0.05);
      const w = WALL_GAP + 0.02 + Math.pow(rng.next(), 1.6) * 0.6;
      const p = wallPoint(wall, u, 0, w);
      if (site.grassFits(p.x, p.z)) addTuft(b, rng, p.x, p.z, rng.range(0.75, 1.15), site.wallNormalsNear(p.x, p.z));
    }
  }
  for (const a of site.anchors) {
    if (!rng.chance(0.75 * (0.4 + 0.6 * detail))) continue;
    const x = a.x + rng.jitter(0.08);
    const z = a.z + rng.jitter(0.08);
    if (!site.grassFits(x, z)) continue;
    addTuft(beds.get(a.wall ?? site.front), rng, x, z, rng.range(0.9, 1.25), site.wallNormalsNear(x, z));
  }
}

function plantAlongWall(beds: Beds, rng: Rng, site: Site, wall: WallSpec, lush: number, extraGap: number, flowers: THREE.Color[], cap: number): void {
  const b = beds.get(wall);
  // A dominant flower colour per wall keeps the beds from looking like confetti.
  const main = rng.pick(flowers);
  // Often a group right at the corner, where planting looks most natural.
  let u = rng.chance(0.5) ? rng.range(-0.04, 0.12) : rng.range(0.3, 1.4) / lush;
  while (u < wall.length - 0.3 && beds.triangles < cap) {
    const end = plantGroup(b, rng, site, wall, u, main, flowers);
    if (end <= u) {
      u += 0.25;
      continue;
    }
    // Open lawn before the next group.
    u = end + rng.range(0.45, 1.8) / lush + extraGap * rng.range(0.5, 1.5);
  }
}

/**
 * A group of one to three plants from u: a lead plant and smaller companions
 * that overlap it a little, some stepping forward from the wall. Returns
 * where the group ends along the wall (u when nothing fitted).
 */
function plantGroup(b: PartBuilder, rng: Rng, site: Site, wall: WallSpec, u: number, main: THREE.Color, flowers: THREE.Color[]): number {
  const size = rng.weighted([
    [1, 3],
    [2, 4],
    [3, 3],
  ]);
  let cursor = u;
  let end = u;
  let placed = 0;
  for (let i = 0; i < size; i++) {
    const lead = placed === 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const probe = Math.min(
        site.heightLimit(wall, cursor - 0.1, cursor + 0.8),
        site.headroom(site.wallFootprint(wall, cursor, cursor + 0.8, WALL_GAP, WALL_GAP + 0.8)),
      );
      const pick = choosePlant(rng, probe, lead);
      if (!pick) {
        cursor += 0.2;
        continue;
      }
      const u0 = lead ? cursor : cursor - rng.range(0.05, 0.2);
      const u1 = u0 + pick.w;
      if (u1 > wall.length + 0.15) return end; // may wrap a little round the corner, no more
      const forward = !lead && rng.chance(0.4);
      const w0 = WALL_GAP + (lead ? rng.range(0, 0.06) : forward ? rng.range(0.14, 0.32) : rng.range(0, 0.1));
      // Plants may nestle into each other, but keep clear of paths and solid things.
      const fp = site.standAgainst(wall, u0, u1, w0, w0 + pick.d, pick.h, 0.03, -0.14);
      if (!fp) {
        cursor += 0.15;
        continue;
      }
      site.claim(fp, 'plant');
      const m = wallMatrix(wall, (u0 + u1) / 2, 0, w0 + pick.d / 2);
      const color = rng.chance(0.75) ? main : rng.pick(flowers);
      addBedPlant(b, rng, m, pick, color, flowers);
      const foot = wallPoint(wall, u0 + pick.w * rng.range(0, 1), 0, w0 + pick.d);
      site.anchors.push({ x: foot.x, z: foot.z, wall });
      cursor = u1;
      end = Math.max(end, u1);
      placed++;
      break;
    }
  }
  return end;
}

/**
 * Pick a plant (and its size) that fits under the height limit, or null.
 * Lead plants are bigger (0.85–1.6× a typical size), companions smaller
 * (0.5–0.95×). Shapes: round bushes, tall clipped ovoids, wide low mounds,
 * flower clumps.
 */
function choosePlant(rng: Rng, limit: number, lead: boolean): PlantPick | null {
  const options: [BedPlant, number][] = [];
  if (limit >= 0.5) options.push(['round', lead ? 4 : 2]);
  if (limit >= 0.85) options.push(['ovoid', lead ? 2.2 : 0.5]);
  if (limit >= 0.36) options.push(['mound', lead ? 2.5 : 2]);
  if (limit >= 0.26) options.push(['flowers', lead ? 1.2 : 4]);
  if (!options.length) return null;
  const scale = lead ? rng.range(0.85, 1.6) : rng.range(0.5, 0.95);
  const flowers = (): PlantPick => {
    const w = rng.range(0.4, 0.68) * Math.sqrt(scale);
    return { kind: 'flowers', w, h: Math.min(limit - 0.05, rng.range(0.22, 0.36)), d: w * rng.range(0.8, 1) };
  };
  const kind = rng.weighted(options);
  if (kind === 'round') {
    const w = 0.62 * scale;
    const h = Math.min(limit - 0.06, w * rng.range(0.75, 0.95));
    return h < 0.3 ? flowers() : { kind, w, h, d: w * rng.range(0.8, 1) };
  }
  if (kind === 'ovoid') {
    const w = 0.46 * scale;
    const h = Math.min(limit - 0.06, w * rng.range(1.45, 1.95));
    return h < w * 1.2 ? flowers() : { kind, w, h, d: w * rng.range(0.85, 1) };
  }
  if (kind === 'mound') {
    const w = 0.82 * scale;
    // Lavender spikes may stand a little proud of the cushion.
    const h = Math.min(limit - 0.12, w * rng.range(0.36, 0.5));
    return h < 0.2 ? flowers() : { kind, w, h, d: Math.min(w * rng.range(0.6, 0.8), 0.85) };
  }
  return flowers();
}

/** Build a picked plant at the origin of `m` (centre of its footprint, local z away from the wall). */
function addBedPlant(b: PartBuilder, rng: Rng, m: THREE.Matrix4, p: PlantPick, color: THREE.Color, flowers: THREE.Color[]): void {
  switch (p.kind) {
    case 'round':
      addShrub(b, rng, m, p.w, p.h, p.d, rng.chance(0.45) ? color : null);
      break;
    case 'ovoid':
      addOvoidShrub(b, rng, m, p.w, p.h, p.d);
      break;
    case 'mound':
      addMound(b, rng, m, p.w, p.h, p.d, color);
      break;
    default:
      addFlowerClump(b, rng, m, p.w, p.h, rng.chance(0.6) ? [color] : flowers, p.d / 2);
  }
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
  // Lumps around the crown, a shade lighter where the sun catches the new
  // growth: small and set into the main mass so they soften the silhouette
  // instead of sticking up like ears.
  const lumps = rng.int(3, 5);
  for (let i = 0; i < lumps; i++) {
    const p = blobSurface(main, upperDirection(rng, 0.05), -0.3);
    const r = rx * rng.range(0.28, 0.4);
    const lr = Math.min(r, rz * 0.7);
    const lump: Blob = {
      x: THREE.MathUtils.clamp(p.x, -halfW + r * BLOB_BULGE, halfW - r * BLOB_BULGE),
      y: Math.min(p.y, height - r * 1.25 * BLOB_BULGE),
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
    const count = Math.round(width * 15);
    for (let i = 0; i < count; i++) addFlowerOnBlob(b, rng, m, rng.pick(blobs), flower, 0.036);
  }
}

/** Darker, denser greens for clipped box / yew. */
const EVERGREEN = ['#46703a', '#4f7a3c', '#3f6a37', '#557f40'];

/**
 * Tall clipped ovoid (box or yew): an upright egg, a little fuller near the
 * top, grown together with a slightly smaller, lighter egg beside it so the
 * silhouette is soft and uneven without lumps sticking out. Same frame and
 * bounds as `addShrub`.
 */
function addOvoidShrub(b: PartBuilder, rng: Rng, m: THREE.Matrix4, width: number, height: number, depth: number): void {
  const leaf = vary(rng.pick(EVERGREEN), rng, 0.05, 0.05, 0.01);
  const halfW = width / 2 - 0.02;
  const halfD = depth / 2 - 0.02;
  const rx = (halfW / BLOB_BULGE) * 0.9;
  const rz = Math.min(rx, halfD / BLOB_BULGE);
  const ry = (height / 2) * 0.98;
  // Sunk a touch into the ground so it looks planted, not balanced on its tip.
  const side = rng.chance(0.5) ? 1 : -1;
  addShrubBlob(b, rng, m, side * rx * 0.1, height - ry * BLOB_BULGE, 0, rx, ry, rz, leaf, 2, height);
  // The companion egg: lower, to one side, a shade lighter.
  const k = rng.range(0.72, 0.85);
  const r2 = rx * k;
  const x2 = THREE.MathUtils.clamp(-side * rx * 0.3, -halfW + r2 * BLOB_BULGE, halfW - r2 * BLOB_BULGE);
  const y2 = height * rng.range(0.82, 0.9) - ry * k * BLOB_BULGE;
  const z2 = THREE.MathUtils.clamp(rng.jitter(rz * 0.3), -halfD + rz * k * BLOB_BULGE, halfD - rz * k * BLOB_BULGE);
  addShrubBlob(b, rng, m, x2, y2, z2, r2, ry * k, rz * k, vary(leaf, rng, 0.03, 0.03, 0.006).offsetHSL(0, 0, 0.02), 1, height);
}

/** Soft grey-greens for low mounds (lavender, catmint, heather). */
const MOUND_LEAVES = ['#6f9257', '#7a9a62', '#668d4f', '#81a067'];
const LAVENDER = '#8b74c6';

/**
 * Wide, low cushion (lavender, catmint, heather): two or three overlapping
 * flattened blobs along the wall, often dusted with tiny flowers or spikes.
 * Same frame and bounds as `addShrub`.
 */
function addMound(b: PartBuilder, rng: Rng, m: THREE.Matrix4, width: number, height: number, depth: number, color: THREE.Color): void {
  const leaf = vary(rng.pick(MOUND_LEAVES), rng, 0.05, 0.05, 0.012);
  const halfW = width / 2 - FLOWER_MARGIN;
  const halfD = depth / 2 - FLOWER_MARGIN;
  const parts = width > 0.75 ? 3 : 2;
  const blobs: Blob[] = [];
  for (let i = 0; i < parts; i++) {
    const t = i / (parts - 1) - 0.5; // -0.5 … 0.5 along the wall
    const centre = i === Math.floor(parts / 2);
    const rx = (halfW / BLOB_BULGE) * (centre ? 0.62 : 0.5);
    const ry = height * (centre ? 0.62 : 0.5);
    const rz = Math.min(halfD / BLOB_BULGE, rx * 1.25) * (centre ? 1 : 0.85);
    const x = THREE.MathUtils.clamp(t * halfW * 1.1, -halfW + rx * BLOB_BULGE, halfW - rx * BLOB_BULGE);
    const blob: Blob = { x, y: (centre ? height : height * 0.82) - ry * BLOB_BULGE, z: rng.jitter(halfD - rz * BLOB_BULGE), rx, ry, rz, v: 0 };
    blob.v = addShrubBlob(b, rng, m, blob.x, blob.y, blob.z, rx, ry, rz, vary(leaf, rng, 0.03, 0.03, 0.006), rx > 0.3 ? 2 : 1, height);
    blobs.push(blob);
  }
  const bloom = rng.weighted([
    ['spikes', 4],
    ['flowers', 3],
    ['plain', 3],
  ] as const);
  if (bloom === 'spikes') {
    // Lavender-like: little upright spikes standing out of the cushion.
    const tip = rng.chance(0.65) ? new THREE.Color(LAVENDER) : color;
    const n = Math.round(width * depth * 70);
    for (let i = 0; i < n; i++) {
      const blob = rng.pick(blobs);
      const d = upperDirection(rng, 0.45);
      const p = blobSurface(blob, d, -0.04).applyMatrix4(m);
      const len = rng.range(0.035, 0.06);
      const sm = mat4(p.x, p.y + len * 0.3, p.z, rng.jitter(0.25), rng.range(0, 6), rng.jitter(0.25), 0.013, len, 0.013);
      b.add(FLOWER_HEAD, 'flower', vary(tip, rng, 0.06, 0.05, 0.012), sm);
    }
  } else if (bloom === 'flowers') {
    const n = Math.round(4 + width * 12);
    for (let i = 0; i < n; i++) addFlowerOnBlob(b, rng, m, rng.pick(blobs), color, 0.024);
  }
}

/**
 * Little open flower (five petals around a golden eye) sitting on the
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
  addFlowerHead(b, fm, vary(color, rng, 0.05, 0.04, 0.01), s);
}

/** A FLOWER placed by `fm` (radius s), with a warm golden eye fading out to the petal tips. */
function addFlowerHead(b: PartBuilder, fm: THREE.Matrix4, color: THREE.Color, s: number): void {
  const eye = color.clone().lerp(FLOWER_EYE, 0.55).multiplyScalar(0.85);
  const centre = new THREE.Vector3(0, 0.12, 0).applyMatrix4(fm);
  b.add(FLOWER, 'flower', color, fm, (p, _n, out) => {
    out.copy(eye).lerp(color, smoothstep(0.15, 0.6, p.distanceTo(centre) / s));
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
  const count = Math.round(4 + width * 16);
  for (let i = 0; i < count; i++) addFlowerOnBlob(b, rng, m, mound, rng.pick(colors), size);
}

/** Tall cottage-garden hollyhocks: a leafy base and 2–4 spires of open, cup-shaped flowers. */
function addHollyhocks(b: PartBuilder, rng: Rng, m: THREE.Matrix4, width: number, height: number, depth: number, color: THREE.Color): void {
  const leaf = vary(rng.pick(LEAVES), rng, 0.05, 0.05, 0.012);
  addShrubBlob(b, rng, m, 0, 0.1, 0, (width / 2 - 0.02) / BLOB_BULGE, 0.3, (depth / 2 - 0.02) / BLOB_BULGE, leaf, 1, 0.4);
  const n = rng.int(2, 4);
  // Leaves reach ~0.12 m sideways from a stem: keep them inside the footprint.
  const spread = Math.max(0, width / 2 - 0.13);
  for (let i = 0; i < n; i++) {
    const x = -spread + (2 * spread * i) / (n - 1);
    const z = rng.jitter(depth * 0.15);
    const h = height * rng.range(0.78, 1);
    // Stems lean a little away from the wall (local +z), never into it.
    const sm = mul(m, mat4(x, 0, z, rng.range(0, 0.07), 0, rng.jitter(0.035)));
    b.add(HOLLYHOCK_STEM, 'foliage', vary('#6f8f4a', rng, 0.04, 0.04, 0.01), mul(sm, mat4(0, 0, 0, 0, 0, 0, 1, h, 1)));
    // Broad leaves up the lower stem, getting smaller.
    for (let y = 0.3; y < h * 0.5; y += rng.range(0.1, 0.14)) {
      const a = rng.range(Math.PI * 1.2, Math.PI * 1.8); // leaves point away from the wall
      const k = 1 - 0.4 * (y / (h * 0.5));
      const lm = mul(sm, mat4(Math.cos(a) * 0.06 * k, y, -Math.sin(a) * 0.06 * k, 0, a, -0.35, 0.1 * k, 0.022, 0.075 * k));
      b.add(PEBBLE, 'foliage', vary(leaf, rng, 0.04, 0.03, 0.01), lm);
    }
    // Open flowers crowding up the upper half (mostly facing out from the
    // wall), shrinking to green buds at the tip.
    const c = vary(color, rng, 0.04, 0.04, 0.01);
    const phase = rng.range(0, Math.PI * 2);
    let k = 0;
    for (let y = h * 0.47; y < h - 0.02; y += rng.range(0.042, 0.056), k++) {
      const t = (y - h * 0.47) / (h * 0.53);
      const a = Math.PI * 1.5 + 1.25 * Math.sin(phase + k * 2.1);
      const s = 0.068 * (1 - t * 0.6);
      const bud = t > 0.8;
      const fm = mul(sm, mat4(Math.cos(a) * 0.022, y, -Math.sin(a) * 0.022, 0, a, -Math.PI / 2 + rng.range(0.1, 0.45), s, s * 0.5, s));
      if (bud) {
        b.add(PEBBLE, 'foliage', c.clone().lerp(leaf, 0.55), mul(fm, mat4(0, 0, 0, 0, 0, 0, 0.6, 1.4, 0.6)));
        continue;
      }
      addFlowerHead(b, fm, c, s);
    }
  }
}

/** Foxglove bell: a cone with its apex at the origin, opening towards -y (6 sides, closed mouth). */
const BELL = new THREE.ConeGeometry(1, 1, 6, 1, false).translate(0, -0.5, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Foxgloves: a low rosette of leaves and one to three spikes hung with
 * drooping bells on the side facing away from the wall, pale-throated,
 * shrinking to buds at the tip.
 */
function addFoxgloves(b: PartBuilder, rng: Rng, m: THREE.Matrix4, width: number, height: number, depth: number, color: THREE.Color): void {
  const leaf = vary(rng.pick(LEAVES), rng, 0.05, 0.05, 0.012);
  addShrubBlob(b, rng, m, 0, 0.05, 0, (width / 2 - 0.02) / BLOB_BULGE, 0.2, (depth / 2 - 0.02) / BLOB_BULGE, leaf, 1, 0.25);
  const n = rng.int(1, 3);
  const spread = Math.max(0, width / 2 - 0.1);
  const throatBase = new THREE.Color('#f4ece2');
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? rng.jitter(0.03) : -spread + (2 * spread * i) / (n - 1);
    const z = rng.jitter(depth * 0.12);
    const h = height * (n === 1 || i === 1 ? rng.range(0.92, 1) : rng.range(0.7, 0.88));
    const sm = mul(m, mat4(x, 0, z, rng.range(0, 0.06), 0, rng.jitter(0.04)));
    b.add(HOLLYHOCK_STEM, 'foliage', vary('#6f8f4a', rng, 0.04, 0.04, 0.01), mul(sm, mat4(0, 0, 0, 0, 0, 0, 0.8, h, 0.8)));
    for (let y = 0.2; y < h * 0.38; y += rng.range(0.09, 0.13)) {
      const a = rng.range(Math.PI * 1.2, Math.PI * 1.8);
      const lm = mul(sm, mat4(Math.cos(a) * 0.05, y, -Math.sin(a) * 0.05, 0, a, -0.3, 0.085, 0.02, 0.06));
      b.add(PEBBLE, 'foliage', vary(leaf, rng, 0.04, 0.03, 0.01), lm);
    }
    const c = vary(color, rng, 0.04, 0.04, 0.01);
    const throat = c.clone().lerp(throatBase, 0.6);
    for (let y = h * 0.4; y < h - 0.03; y += rng.range(0.032, 0.045)) {
      const t = (y - h * 0.4) / (h * 0.6);
      const a = Math.PI * 1.5 + rng.jitter(1.0); // around the front of the stem
      const radial = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
      if (t > 0.84) {
        const bm = mul(sm, mat4(radial.x * 0.012, y, radial.z * 0.012, 0, 0, 0, 0.011, 0.02, 0.011));
        b.add(PEBBLE, 'foliage', c.clone().lerp(leaf, 0.5), bm);
        continue;
      }
      const len = 0.068 * (1 - 0.45 * t);
      const r = len * 0.42;
      // Hanging from the stem, mouth tipped out and down.
      const dir = radial.clone().multiplyScalar(rng.range(0.75, 1.05)).add(new THREE.Vector3(0, -1, 0)).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(DOWN, dir);
      const pos = new THREE.Vector3(radial.x * 0.012, y, radial.z * 0.012);
      const bm = mul(sm, new THREE.Matrix4().compose(pos, q, new THREE.Vector3(r, len, r)));
      const mouth = dir.clone().transformDirection(sm);
      b.add(BELL, 'flower', c, bm, (_p, nn, out) => {
        if (nn.dot(mouth) > 0.7) out.copy(throat);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Feature plants: flower spikes by the door or a corner, a climber
// ---------------------------------------------------------------------------

const HOLLYHOCK_COLORS = ['#e27fa3', '#c9506e', '#f0b5c4', '#efd88f', '#b8476a'];
const FOXGLOVE_COLORS = ['#b46cb4', '#d48cc0', '#e8d6e4', '#c27ab0'];

/** A place to start along a ground-floor wall, growing from u in direction `dir`. */
interface WallEdge {
  wall: WallSpec;
  u: number;
  dir: 1 | -1;
}

/** The corners of the ground floor as wall edges: the ones on the front half first, otherwise shuffled. */
function cornerEdges(site: Site, rng: Rng, inset: number): WallEdge[] {
  const edges: WallEdge[] = [];
  for (const wall of site.walls) edges.push({ wall, u: inset, dir: 1 }, { wall, u: wall.length - inset, dir: -1 });
  for (let i = edges.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [edges[i], edges[j]] = [edges[j], edges[i]];
  }
  const back = (e: WallEdge) => (wallPoint(e.wall, e.u, 0, 0).z > 0 ? 0 : 1);
  return edges.sort((a, b) => back(a) - back(b));
}

/** The two sides of the door (just outside `edge`), in random order. */
function doorEdges(site: Site, rng: Rng, left: number, right: number): WallEdge[] {
  const edges: WallEdge[] = [
    { wall: site.front, u: right, dir: 1 },
    { wall: site.front, u: left, dir: -1 },
  ];
  return rng.chance(0.5) ? edges : edges.reverse();
}

/** One or two stands of tall flower spikes (hollyhocks or foxgloves) beside the steps or at a corner. */
function buildSpikes(site: Site, beds: Beds, rng: Rng): void {
  const count = rng.weighted([
    [0, 1],
    [1, 5],
    [2, 4],
  ] as const);
  if (!count) return;
  const { stoop } = site.layout;
  const byDoor = doorEdges(site, rng, stoop.u0 - 0.04, stoop.u1 + 0.04);
  const corners = cornerEdges(site, rng, 0.06);
  const edges = rng.chance(0.7) ? [...byDoor, ...corners] : [...corners, ...byDoor];
  const foxglove = rng.chance(0.45);
  const color = new THREE.Color(
    rng.chance(0.55) ? rng.pick(foxglove ? FOXGLOVE_COLORS : HOLLYHOCK_COLORS) : rng.pick(flowerColors(site.palette)),
  );
  let placed = 0;
  for (const e of edges) {
    if (placed >= count) break;
    if (placeSpikes(site, beds, rng, e, foxglove, color)) placed++;
  }
}

/** Slide a stand of spikes along the wall from `e` until it fits; false when it never does. */
function placeSpikes(site: Site, beds: Beds, rng: Rng, e: WallEdge, foxglove: boolean, color: THREE.Color): boolean {
  const width = rng.range(0.34, 0.5);
  const depth = width * rng.range(0.8, 1);
  const want = rng.range(1.3, 1.85);
  for (let off = 0; off < 0.9; off += 0.08) {
    const u0 = e.dir > 0 ? e.u + off : e.u - off - width;
    const u1 = u0 + width;
    if (u0 < -0.02 || u1 > e.wall.length + 0.02) return false;
    const w0 = WALL_GAP + rng.range(0, 0.05);
    // Tall spires sway: keep some extra room from the windows on either side.
    const limit = Math.min(site.heightLimit(e.wall, u0 - 0.15, u1 + 0.15), site.headroom(site.wallFootprint(e.wall, u0, u1, w0, w0 + depth)));
    const h = Math.min(limit - 0.1, want);
    if (h < 1.05) continue;
    const fp = site.standAgainst(e.wall, u0, u1, w0, w0 + depth, h, 0.03, -0.04);
    if (!fp) continue;
    site.claim(fp, 'plant');
    const m = wallMatrix(e.wall, (u0 + u1) / 2, 0, w0 + depth / 2);
    const c = vary(color, rng, 0.04, 0.04, 0.01);
    if (foxglove) addFoxgloves(beds.get(e.wall), rng, m, width, h, depth, c);
    else addHollyhocks(beds.get(e.wall), rng, m, width, h, depth, c);
    site.anchorFront(e.wall, u0, u1, w0 + depth);
    return true;
  }
  return false;
}

type ClimberKind = 'rose' | 'ivy';
const ROSE_COLORS = ['#e46f8e', '#d4475b', '#f0bfca', '#f3e0c2', '#c93f63'];
const ROSE_LEAVES = ['#4f7f3b', '#5a8743', '#4a7838'];
const IVY_LEAVES = ['#3d6834', '#46733a', '#38612f', '#4b783c'];

/**
 * Sometimes a climbing rose or a patch of ivy growing up a corner (over the
 * quoins / corner post, wrapping round onto the next wall) or beside the
 * door. It stays clear of every window with its shutters and flower box,
 * the door and its hood, the lantern, the joists / band at the top of the
 * storey and the eaves, and never comes closer to the wall than w = 0.085.
 */
function buildClimber(site: Site, rng: Rng): PartBuilder | null {
  if (!rng.chance(0.55)) return null;
  const kind: ClimberKind = rng.chance(0.55) ? 'rose' : 'ivy';
  const style: ClimberStyle = {
    kind,
    leaf: vary(rng.pick(kind === 'ivy' ? IVY_LEAVES : ROSE_LEAVES), rng, 0.04, 0.04, 0.01),
    rose: new THREE.Color(rng.chance(0.6) ? rng.pick(ROSE_COLORS) : rng.pick(flowerColors(site.palette))),
  };
  // As wide as there is room for (a wall without windows can take a big one).
  const widest = kind === 'ivy' ? rng.range(0.9, 1.4) : rng.range(0.7, 1.0);
  const { door, doorHood: hood } = site.layout;
  const byDoor = doorEdges(site, rng, Math.min(hood.u0, door.surround.u0) - 0.18, Math.max(hood.u1, door.surround.u1) + 0.18);
  const corners = cornerEdges(site, rng, 0.03);
  const edges = kind === 'rose' && rng.chance(0.55) ? [...byDoor, ...corners] : [...corners, ...byDoor];
  const target = kind === 'ivy' ? rng.range(2.1, 3.0) : rng.range(1.9, 2.6);
  for (const e of edges) {
    const corner = e.u < 0.1 || e.u > e.wall.length - 0.1;
    for (let off = 0, width = widest; off <= 0.6; ) {
      const u0 = e.dir > 0 ? e.u + off : e.u - off - width;
      const u1 = u0 + width;
      const h = u0 < 0.02 || u1 > e.wall.length - 0.02 ? 0 : Math.min(target, climberCeiling(site, e.wall, u0, u1));
      if (h < 1.5) {
        // Narrower first, then further along.
        if (width > 0.5) width = Math.max(0.45, width * 0.75);
        else [off, width] = [off + 0.1, widest];
        continue;
      }
      // The roots and the foot of the stems claim a shallow strip of ground.
      const fp = site.wallFootprint(e.wall, u0 + 0.04, u1 - 0.04, WALL_GAP - 0.02, WALL_GAP + 0.1);
      if (!site.fits(fp, 0.02, 0)) {
        [off, width] = [off + 0.1, widest];
        continue;
      }
      site.claim(fp, 'plant');
      const root = e.dir > 0 ? u0 + Math.min(0.18, width * 0.25) : u1 - Math.min(0.18, width * 0.25);
      const b = new PartBuilder('props:climber');
      b.explode = wallExplode(e.wall, OUTWARD.props);
      addClimberPlant(b, rng, site, e.wall, u0, u1, root, h, style, 2);
      site.anchorFront(e.wall, root - 0.05, root + 0.05, WALL_GAP);
      if (corner && off < 0.15) wrapCorner(b, rng, site, e, h, style);
      return b;
    }
  }
  return null;
}

/** A corner climber spills round onto the neighbouring wall: a smaller patch from the same corner. */
function wrapCorner(b: PartBuilder, rng: Rng, site: Site, e: WallEdge, h: number, style: ClimberStyle): void {
  // Walls run front, right, back, left; wall i ends where wall i + 1 starts.
  const i = site.walls.indexOf(e.wall);
  const next = e.dir > 0 ? site.walls[(i + 3) % 4] : site.walls[(i + 1) % 4];
  const width = rng.range(0.3, 0.5);
  const [u0, u1] = e.dir > 0 ? [next.length - 0.03 - width, next.length - 0.03] : [0.03, 0.03 + width];
  const h2 = Math.min(h * rng.range(0.55, 0.85), climberCeiling(site, next, u0, u1));
  if (h2 < 0.9) return;
  const fp = site.wallFootprint(next, u0 + 0.04, u1 - 0.04, WALL_GAP - 0.02, WALL_GAP + 0.1);
  if (!site.fits(fp, 0.02, 0)) return;
  site.claim(fp, 'plant');
  const root = e.dir > 0 ? u1 - 0.08 : u0 + 0.08;
  addClimberPlant(b, rng, site, next, u0, u1, root, h2, style, 1);
}

/** How high a climber may grow on u ∈ [u0, u1] of a ground-floor wall. */
function climberCeiling(site: Site, wall: WallSpec, u0: number, u1: number): number {
  const { layout } = site;
  const ground = layout.storeys[0];
  // Leaves spread ~0.1 m past the strip: keep 0.14 from every zone, and stay below it.
  if (site.keepClear.some((k) => k.wall === wall && u0 - 0.14 < k.u1 && u1 + 0.14 > k.u0)) return 0;
  const zones = site.heightLimit(wall, u0 - 0.14, u1 + 0.14) - 0.12;
  // Under the joists of a jetty, the storey band or top plate, or the eave.
  const jettied = !wall.isGable && ground.joistZone > 0;
  const band = layout.storeys.length > 1 ? ground.y1 - (jettied ? ground.joistZone + 0.08 : 0.2) : ground.y1 - 0.15;
  const p = wallPoint(wall, (u0 + u1) / 2, 0, 0.3);
  return Math.min(zones, band, site.headroomAt(p.x, p.z) - 0.05);
}

const STEM = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);

/**
 * Leaf clump for climbers: a soft lens, round in its own x/y plane (radius
 * 1), domed out towards +z (1) and flatter behind (-0.35). 20 triangles,
 * like PEBBLE, but with a round silhouette seen face-on.
 */
const CLIMB_LEAF = (() => {
  const n = 10;
  const pos: number[] = [0, 0, 1, 0, 0, -0.35];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 1 + 0.06 * Math.sin(a * 3);
    pos.push(Math.cos(a) * r, Math.sin(a) * r, 0);
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = 2 + i;
    const c = 2 + ((i + 1) % n);
    idx.push(0, a, c, 1, c, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
})();

/** A woody stem segment from a to b (wall-local), radius r. */
function addStem(b: PartBuilder, frame: THREE.Matrix4, a: THREE.Vector3, c: THREE.Vector3, r: number, color: THREE.Color): void {
  const d = c.clone().sub(a);
  const len = d.length();
  if (len < 1e-4) return;
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.multiplyScalar(1 / len));
  const mid = a.clone().add(c).multiplyScalar(0.5);
  b.add(STEM, 'wood', color, mul(frame, new THREE.Matrix4().compose(mid, q, new THREE.Vector3(r, len + r, r))));
}

/** Look of one climbing plant (shared by the patches either side of a corner). */
interface ClimberStyle {
  kind: ClimberKind;
  leaf: THREE.Color;
  rose: THREE.Color;
}

/**
 * The climber itself, in wall-local coordinates: woody stems from the root
 * fanning up the wall, covered by flattened leaf clumps in a ragged fan
 * that is narrow at the root and spreads out above; roses get clusters of
 * flowers and buds, ivy a denser, darker coat.
 */
function addClimberPlant(
  b: PartBuilder,
  rng: Rng,
  site: Site,
  wall: WallSpec,
  u0: number,
  u1: number,
  root: number,
  H: number,
  style: ClimberStyle,
  stems: number,
): void {
  const ivy = style.kind === 'ivy';
  const plinth = site.layout.params.plinthHeight;
  const uc = (u0 + u1) / 2;
  const half = (u1 - u0) / 2;
  const at = (u: number, y: number, w: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number) =>
    mul(wall.frame, mat4(u, y, w, rx, ry, rz, sx, sy, sz));
  // Nearest a leaf may come to the wall at height y: clear of the plinth band, stones and beams.
  const wMin = (y: number) => (y < plinth + 0.06 ? 0.115 : 0.085);
  const ph = rng.range(0, 6);
  // Leaf clumps reach ~0.1 past this outline, so it keeps that much inside [u0, u1].
  const halfAt = (y: number) => {
    const t = y / H;
    const body = 0.22 + 0.78 * smoothstep(0, 0.62, t);
    const crown = Math.sqrt(Math.max(0, 1 - smoothstep(0.8, 1.02, t)));
    return Math.max(0.04, (half - 0.06) * body * crown * (0.84 + 0.16 * Math.sin(t * 7 + ph)));
  };
  const centreAt = (y: number) => THREE.MathUtils.lerp(root, uc, smoothstep(0, 0.55, y / H));

  // Woody stems fanning up from the root.
  const stemColor = vary(ivy ? '#5a4d39' : '#665638', rng, 0.05, 0.04, 0.01);
  for (let i = 0; i < stems; i++) {
    const spread = stems === 1 ? 0 : (i / (stems - 1)) * 2 - 1;
    const top = H * rng.range(0.45, 0.75);
    let prev = new THREE.Vector3(root + rng.jitter(0.03), 0, WALL_GAP + 0.01);
    for (let k = 1; k <= 5; k++) {
      const y = (top * k) / 5;
      const r = 0.016 * (1 - 0.45 * (k / 5));
      const next = new THREE.Vector3(
        centreAt(y) + spread * halfAt(y) * 0.7 + rng.jitter(0.025),
        y,
        Math.max(wMin(y) + r + 0.01, THREE.MathUtils.lerp(WALL_GAP + 0.01, 0.105, k / 5)),
      );
      addStem(b, wall.frame, prev, next, r, stemColor);
      prev = next;
    }
  }

  // Leaf clumps in loose, staggered rows; a few gaps let the wall show through.
  const cell = (ivy ? 0.12 : 0.13) / Math.sqrt(Math.max(0.6, site.layout.detail));
  let row = 0;
  for (let y = 0.16; y < H - cell * 0.4; y += cell * 0.74, row++) {
    const hw = halfAt(y);
    const c = centreAt(y);
    const n = Math.max(1, Math.round((2 * hw) / (cell * 0.9)));
    for (let i = 0; i < n; i++) {
      if (rng.chance(ivy ? 0.04 : 0.08)) continue;
      const edge = n > 2 && (i === 0 || i === n - 1);
      const r = cell * rng.range(0.6, 0.85) * (y < 0.45 ? 0.8 : 1) * (edge ? 0.8 : 1);
      const rz = r * rng.range(0.38, 0.5);
      const yy = Math.min(y + rng.jitter(cell * 0.25), H - r);
      const stagger = (row % 2 ? 0.25 : -0.25) * ((2 * hw) / n);
      const u = THREE.MathUtils.clamp(c - hw + (2 * hw * (i + 0.5)) / n + stagger + rng.jitter(cell * 0.25), 0.03 + r, wall.length - 0.03 - r);
      // The lens reaches 0.35·rz behind its centre; tilted, its rim up to ~0.22·r.
      const w = wMin(yy - r) + Math.max(0.35 * rz, 0.22 * r) + rng.range(0.005, 0.045);
      const col = vary(style.leaf, rng, 0.05, 0.04, 0.01).multiplyScalar(0.84 + 0.22 * (yy / H));
      if (rng.chance(ivy ? 0.14 : 0.08)) col.offsetHSL(0.01, 0.03, 0.05); // fresh growth
      b.add(CLIMB_LEAF, 'foliage', col, at(u, yy, w, rng.jitter(0.15), rng.jitter(0.15), rng.range(0, Math.PI), r, r * rng.range(0.78, 0.95), rz));
    }
  }

  if (ivy) return;
  // Roses in little clusters facing out of the leaves, with a few buds.
  const clusters = Math.max(2, Math.round(H * (u1 - u0) * 9));
  for (let i = 0; i < clusters; i++) {
    const y0 = H * rng.range(0.25, 0.92);
    const uC = centreAt(y0) + rng.jitter(halfAt(y0) * 0.85);
    const count = rng.int(1, 3);
    for (let k = 0; k < count; k++) {
      const y = y0 + rng.jitter(0.06);
      const u = THREE.MathUtils.clamp(uC + rng.jitter(0.07), 0.07, wall.length - 0.07);
      const bud = rng.chance(0.22);
      const s = bud ? rng.range(0.018, 0.024) : rng.range(0.045, 0.062);
      const w = wMin(y) + 0.09 + rng.range(0, 0.03);
      if (bud) {
        b.add(PEBBLE, 'flower', vary(style.rose, rng, 0.05, 0.04, 0.01).multiplyScalar(0.85), at(u, y, w, 0, 0, 0, s, s * 1.3, s));
        continue;
      }
      const nrm = new THREE.Vector3(rng.jitter(0.35), rng.jitter(0.3) - 0.1, 1).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(UP, nrm).multiply(new THREE.Quaternion().setFromAxisAngle(UP, rng.range(0, Math.PI)));
      const fm = mul(wall.frame, new THREE.Matrix4().compose(new THREE.Vector3(u, y, w), q, new THREE.Vector3(s, s * 0.8, s)));
      addFlowerHead(b, fm, vary(style.rose, rng, 0.05, 0.04, 0.01), s);
    }
  }
}

/**
 * A tuft of grass blades at plan (x, z). Blades that would lean towards one
 * of the `away` walls (outward normals) are mirrored to lean away instead.
 */
function addTuft(b: PartBuilder, rng: Rng, x: number, z: number, scale: number, away: readonly { x: number; z: number }[] = [], maxTilt = 0.55): void {
  const root = vary(GRASS_ROOT, rng, 0.04, 0.04, 0.012);
  const tip = vary(GRASS_TIP, rng, 0.05, 0.05, 0.015);
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    let yaw = rng.range(0, Math.PI * 2);
    const tilt = rng.range(0.08, maxTilt);
    const h = scale * rng.range(0.1, 0.21);
    const off = rng.range(0, 0.04);
    const r = scale * rng.range(0.015, 0.022);
    // With Euler (0, yaw, tilt) a blade leans towards (-cos yaw, 0, sin yaw);
    // walls meet at right angles, so mirroring off each in turn is enough.
    for (const wn of away) {
      const lx = -Math.cos(yaw);
      const lz = Math.sin(yaw);
      const d = lx * wn.x + lz * wn.z;
      if (d < 0) yaw = Math.atan2(lz - 2 * d * wn.z, -(lx - 2 * d * wn.x));
    }
    // Roots spread a little the way their blades lean: the tuft fans out.
    const m = mat4(x - Math.cos(yaw) * off, 0, z + Math.sin(yaw) * off, 0, yaw, tilt, r, h, r);
    const top = h * Math.cos(tilt);
    b.add(GRASS_BLADE, 'foliage', root, m, (p, _n, out) => {
      out.copy(root).lerp(tip, THREE.MathUtils.clamp(p.y / top, 0, 1));
    });
  }
}
