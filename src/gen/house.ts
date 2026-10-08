import * as THREE from 'three';
import type { MatKey, PartBuilder } from './builder';
import { computeLayout, type HouseLayout } from './layout';
import type { HouseParams } from './params';
import { Rng } from './rng';
import { PARTS } from './parts';

/** What a part builder receives. */
export interface PartContext {
  layout: HouseLayout;
  /** RNG stream private to this part (forked from the house seed). */
  rng: Rng;
}

/**
 * A part of the house. `build` returns one or more PartBuilders; the house
 * merges each builder per material. `explode` is the offset this part moves
 * by in the exploded view (at explode = 1); each builder can add its own
 * `explode` offset on top (e.g. windows flying out of their wall).
 */
export interface PartDef {
  name: string;
  label: string;
  explode: [number, number, number];
  build: (ctx: PartContext) => PartBuilder | PartBuilder[];
}

export interface HouseStats {
  triangles: number;
  /** Triangles per part. */
  parts: Record<string, number>;
  /** Generation time per part (build + merge), ms. */
  partMs: Record<string, number>;
  ms: number;
}

export interface GeneratedHouse {
  group: THREE.Group;
  layout: HouseLayout;
  stats: HouseStats;
}

/**
 * Params → layout → parts → one THREE.Group with a child group per part
 * (`group.getObjectByName('roof')` etc.).
 */
export function generateHouse(
  params: HouseParams,
  materials: Record<MatKey, THREE.Material>,
  opts: { parts?: string[] } = {},
): GeneratedHouse {
  const t0 = performance.now();
  const layout = computeLayout(params);
  const root = new Rng(params.seed);
  const group = new THREE.Group();
  group.name = 'house';
  const stats: HouseStats = { triangles: 0, parts: {}, partMs: {}, ms: 0 };

  for (const part of PARTS) {
    if (opts.parts && !opts.parts.includes(part.name)) continue;
    const tPart = performance.now();
    let builders: PartBuilder[];
    try {
      const out = part.build({ layout, rng: root.fork(part.name) });
      builders = Array.isArray(out) ? out : [out];
    } catch (err) {
      // One broken detail should not take the whole house down.
      console.error(`part "${part.name}" failed for seed ${params.seed}:`, err);
      continue;
    }
    const partGroup = new THREE.Group();
    partGroup.name = part.name;
    partGroup.userData.explode = new THREE.Vector3(...part.explode);
    let tris = 0;
    for (const b of builders) {
      if (b.isEmpty) continue;
      tris += b.triangles;
      const g = b.build(materials);
      g.userData.explode = new THREE.Vector3(...b.explode);
      partGroup.add(g);
    }
    stats.parts[part.name] = Math.round(tris);
    stats.partMs[part.name] = Math.round(performance.now() - tPart);
    stats.triangles += Math.round(tris);
    group.add(partGroup);
  }
  stats.ms = Math.round(performance.now() - t0);
  return { group, layout, stats };
}
