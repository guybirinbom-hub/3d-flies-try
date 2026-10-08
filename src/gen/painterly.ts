import type * as THREE from 'three';

/**
 * Soft, hand-painted surface variation for the viewer: a low-frequency
 * world-space noise that gently mottles each material's colour (plaster gets
 * patchy, stone gets a weathered tone, roof tiles drift in hue).
 *
 * It is a shader tweak only, so exported glTF files keep just the vertex
 * colours, which already carry per-piece variation.
 */

/** The viewer's settings per material slot. */
export const PAINTERLY: Partial<Record<string, PainterlyOptions>> = {
  plaster: { amount: 0.08, scale: 0.6, damp: 0.12 },
  mortar: { amount: 0.04, scale: 0.8, damp: 0.1 },
  stone: { amount: 0.035, scale: 1.4, damp: 0.08 },
  roof: { amount: 0.05, scale: 0.35 },
  timber: { amount: 0.03, scale: 1.1 },
  wood: { amount: 0.03, scale: 1.3 },
};
export interface PainterlyOptions {
  /** Strength of the mottling (0 = off). */
  amount: number;
  /** World-space frequency of the noise (higher = smaller blotches). */
  scale: number;
  /** Darken surfaces near the ground (damp, splash), 0–1. */
  damp?: number;
}

const NOISE_GLSL = /* glsl */ `
varying vec3 vHwWorld;
float hwHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float hwNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hwHash(i + vec3(0, 0, 0)), hwHash(i + vec3(1, 0, 0)), f.x),
                 mix(hwHash(i + vec3(0, 1, 0)), hwHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hwHash(i + vec3(0, 0, 1)), hwHash(i + vec3(1, 0, 1)), f.x),
                 mix(hwHash(i + vec3(0, 1, 1)), hwHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float hwFbm(vec3 p) {
  return 0.55 * hwNoise(p) + 0.3 * hwNoise(p * 2.03 + 7.1) + 0.15 * hwNoise(p * 4.11 + 3.7);
}
`;

export function applyPainterly(material: THREE.Material, opts: PainterlyOptions): void {
  if (opts.amount <= 0) return;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHwWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvHwWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= 1.0 + ${opts.amount.toFixed(3)} * (hwFbm(vHwWorld * ${opts.scale.toFixed(3)}) - 0.5) * 2.0;
        diffuseColor.rgb *= 1.0 - ${(opts.damp ?? 0).toFixed(3)} * (1.0 - smoothstep(0.05, 0.75, vHwWorld.y)) * (0.6 + 0.4 * hwNoise(vHwWorld * 3.0));`,
      );
  };
  material.customProgramCacheKey = () => `painterly-${opts.amount}-${opts.scale}-${opts.damp ?? 0}`;
  material.needsUpdate = true;
}
