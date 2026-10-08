import { Color, SRGBColorSpace } from 'three';
import { Rng } from './rng';

/** How the outer surface of a storey is built. */
export type WallStyle = 'stone' | 'plaster' | 'timber';

/** Colours for one house. Hex strings so they survive JSON / URL round-trips. */
export interface Palette {
  stone: string; // average field-stone colour
  mortar: string;
  plaster: string;
  timber: string; // structural beams
  wood: string; // doors, planks
  trim: string; // window frames
  shutter: string;
  roof: string;
  flowers: string[];
}

/**
 * The high-level description of a house. This is everything a user (or a
 * higher-level village generator) gets to choose; every dimension of the
 * actual geometry is derived from it in `computeLayout`.
 */
export interface HouseParams {
  seed: number;
  /** Outer length of the ground floor along X (the ridge direction), metres. */
  width: number;
  /** Outer depth of the ground floor along Z, metres. */
  depth: number;
  /** Number of full storeys (1–3). The roof space is extra. */
  floors: number;
  /** Floor-to-floor height of a storey. */
  storeyHeight: number;
  /** Height of the raised stone plinth / interior floor level above ground. */
  plinthHeight: number;
  wallThickness: number;
  groundStyle: WallStyle;
  upperStyle: WallStyle;
  /** How far upper storeys project over the one below (front & back), metres. */
  jetty: number;
  /** Roof pitch in degrees. */
  roofPitch: number;
  /** Roof overhang past the eave walls (front/back), metres. */
  eaveOverhang: number;
  /** Roof overhang past the gable walls (left/right), metres. */
  gableOverhang: number;
  /** Horizontal distance between window centres, metres. */
  windowSpacing: number;
  /** Door position along the front wall, -1 (left) .. 1 (right). */
  doorOffset: number;
  archedDoor: boolean;
  chimney: boolean;
  /** Which gable end the chimney sits near. */
  chimneySide: 'left' | 'right';
  shutters: boolean;
  flowerBoxes: boolean;
  /** Small decorative props around the house (lantern, bench, barrel, plants). */
  props: boolean;
  /** Dormers on the roof: -1 lets the generator decide, otherwise 0–3. */
  dormers: number;
  /** Roof covering, or 'auto' to pick one that suits the roof colour. */
  roofCovering: 'auto' | 'beaver' | 'fish' | 'slate' | 'shingle';
  palette: Palette;
}

export const PALETTES: Record<string, Palette> = {
  terracotta: {
    stone: '#b7aa98',
    mortar: '#8f877c',
    plaster: '#efe6d2',
    timber: '#5b4232',
    wood: '#7a5638',
    trim: '#f3efe6',
    shutter: '#6f8f6a',
    roof: '#b4573c',
    flowers: ['#e0587a', '#f2c14e', '#f7f3ea', '#c06ad8'],
  },
  slate: {
    stone: '#a9a49b',
    mortar: '#7f7a73',
    plaster: '#f2efe8',
    timber: '#4a3a30',
    wood: '#6b4a32',
    trim: '#eae6dc',
    shutter: '#4f6d8c',
    roof: '#5f6a78',
    flowers: ['#e8584f', '#f7f3ea', '#f2a541'],
  },
  moss: {
    stone: '#bcae92',
    mortar: '#958a77',
    plaster: '#f1e3c4',
    timber: '#6a4a33',
    wood: '#865e3c',
    trim: '#f6f1e4',
    shutter: '#7f97a8',
    roof: '#6b6e4a',
    flowers: ['#f4d35e', '#ee964b', '#f7f3ea'],
  },
  rose: {
    stone: '#c2b2a3',
    mortar: '#9a8d81',
    plaster: '#f3d9cf',
    timber: '#55402f',
    wood: '#6e4c34',
    trim: '#fbf6ef',
    shutter: '#5a7f87',
    roof: '#9d4b46',
    flowers: ['#f7f3ea', '#f7a1c4', '#b5179e'],
  },
  ochre: {
    stone: '#c7b394',
    mortar: '#9b8c74',
    plaster: '#ecd29b',
    timber: '#4f3a2b',
    wood: '#7b5132',
    trim: '#fdf8ee',
    shutter: '#3f6e6e',
    roof: '#a65d3f',
    flowers: ['#d62828', '#f7f3ea', '#f77f00'],
  },
  heather: {
    stone: '#b3a99c',
    mortar: '#8c857a',
    plaster: '#efe6da',
    timber: '#4d3b2e',
    wood: '#74533a',
    trim: '#f6f2ea',
    shutter: '#7d6aa0',
    roof: '#7a5a45',
    flowers: ['#c77dff', '#f7f3ea', '#ff8fab'],
  },
  harbour: {
    stone: '#aeaba3',
    mortar: '#85827b',
    plaster: '#f3f0e9',
    timber: '#4b4038',
    wood: '#6f5440',
    trim: '#fbf8f2',
    shutter: '#c2563b',
    roof: '#53677a',
    flowers: ['#ffb703', '#f7f3ea', '#e63946'],
  },
  meadow: {
    stone: '#bfb39e',
    mortar: '#978c79',
    plaster: '#f2ead6',
    timber: '#5a4331',
    wood: '#80583a',
    trim: '#f8f4ea',
    shutter: '#3e6b8a',
    roof: '#8c3b2e',
    flowers: ['#f9c74f', '#f7f3ea', '#f3722c'],
  },
};

export function defaultParams(): HouseParams {
  return {
    seed: 1,
    width: 8.5,
    depth: 5.6,
    floors: 2,
    storeyHeight: 2.7,
    plinthHeight: 0.45,
    wallThickness: 0.42,
    groundStyle: 'stone',
    upperStyle: 'timber',
    jetty: 0.25,
    roofPitch: 48,
    eaveOverhang: 0.45,
    gableOverhang: 0.35,
    windowSpacing: 2.4,
    doorOffset: -0.15,
    archedDoor: true,
    chimney: true,
    chimneySide: 'right',
    shutters: true,
    flowerBoxes: true,
    props: true,
    dormers: -1,
    roofCovering: 'auto',
    palette: { ...PALETTES.terracotta, flowers: [...PALETTES.terracotta.flowers] },
  };
}

/** A coherent random house for a seed. Same seed → same house. */
export function randomParams(seed: number): HouseParams {
  const rng = new Rng(seed).fork('params');
  // Mostly cottages and two-storey houses; three storeys are the rare town house.
  const floors = rng.weighted([
    [1, 4],
    [2, 5],
    [3, 0.7],
  ] as const);
  // Chunky rather than tall: three storeys need a big footprint.
  const width = round(floors === 3 ? rng.range(9, 12) : rng.range(floors === 1 ? 6 : 7, 11), 0.1);
  const minDepth = floors === 3 ? Math.max(5.8, width * 0.55) : 4.6;
  const depth = round(rng.range(minDepth, Math.max(minDepth, Math.min(floors === 3 ? 7.5 : 6.8, width * 0.85))), 0.1);
  const groundStyle = rng.weighted([
    ['stone', 6],
    ['plaster', 3],
    ['timber', 1],
  ] as const);
  // Timber ground floors carry timber above; stone goes up only over stone.
  const upperStyle =
    floors === 1
      ? groundStyle
      : groundStyle === 'timber'
        ? rng.weighted([['timber', 6], ['plaster', 1]] as const)
        : rng.weighted([['timber', 5], ['plaster', 3], ['stone', groundStyle === 'stone' ? 2 : 0]] as const);
  // A big roof over low walls is what makes it cosy: cottages get steep roofs,
  // tall houses gentler ones.
  const roofPitch = Math.round(floors === 1 ? rng.range(46, 57) : floors === 2 ? rng.range(43, 55) : rng.range(38, 47));
  const base = PALETTES[rng.pick(Object.keys(PALETTES))];
  const palette: Palette = {
    ...base,
    // Small per-house drift so neighbours with the same palette still differ.
    plaster: jitterHex(base.plaster, rng, 0.012, 0.03, 0.02),
    shutter: jitterHex(base.shutter, rng, 0.03, 0.08, 0.05),
    roof: jitterHex(base.roof, rng, 0.012, 0.06, 0.04),
    flowers: [...base.flowers],
  };
  // A house with no timber needs some other charm on its walls.
  const hasTimber = groundStyle === 'timber' || (floors > 1 && upperStyle === 'timber');
  let shutters = rng.chance(0.7);
  let flowerBoxes = rng.chance(0.65);
  if (!hasTimber && !shutters && !flowerBoxes) {
    if (rng.chance(0.5)) shutters = true;
    else flowerBoxes = true;
  }
  return {
    seed,
    width,
    depth,
    floors,
    storeyHeight: round(rng.range(2.4, 2.7), 0.05),
    plinthHeight: round(rng.range(floors === 3 ? 0.25 : 0.3, floors === 3 ? 0.45 : 0.6), 0.05),
    wallThickness: round(rng.range(0.36, 0.48), 0.01),
    groundStyle,
    upperStyle,
    jetty: floors > 1 && upperStyle === 'timber' && rng.chance(0.6) ? round(rng.range(0.15, 0.35), 0.05) : 0,
    roofPitch,
    eaveOverhang: round(rng.range(0.3, 0.6), 0.05),
    gableOverhang: round(rng.range(0.2, 0.45), 0.05),
    windowSpacing: round(rng.range(2.0, 3.0), 0.1),
    doorOffset: round(rng.range(-0.6, 0.6), 0.05),
    archedDoor: rng.chance(0.5),
    chimney: rng.chance(0.85),
    chimneySide: rng.chance(0.5) ? 'left' : 'right',
    shutters,
    flowerBoxes,
    props: true,
    dormers: -1,
    roofCovering: 'auto',
    palette,
  };
}

/** Hex colour nudged in hue / saturation / lightness (sRGB), as hex again. */
function jitterHex(hex: string, rng: Rng, h: number, s: number, l: number): string {
  const c = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, SRGBColorSpace);
  c.setHSL(
    (hsl.h + rng.jitter(h) + 1) % 1,
    Math.min(1, Math.max(0, hsl.s + rng.jitter(s))),
    Math.min(0.97, Math.max(0.03, hsl.l + rng.jitter(l))),
    SRGBColorSpace,
  );
  return `#${c.getHexString(SRGBColorSpace)}`;
}

function round(v: number, step: number): number {
  return Number((Math.round(v / step) * step).toFixed(4));
}
