#!/usr/bin/env node
/**
 * Robustness sweep: generates many houses in Node (no rendering) and checks
 * each one for exceptions, console errors, NaN vertices and runaway geometry.
 *
 *   node scripts/sweep.mjs [--count 200] [--start 0] [--parts roof,walls] [--set p.floors=3 ...]
 */
import { createServer } from 'vite';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let count = 200;
let start = 0;
let parts;
const overrides = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--count') count = Number(argv[++i]);
  else if (argv[i] === '--start') start = Number(argv[++i]);
  else if (argv[i] === '--parts') parts = argv[++i].split(',');
  else if (argv[i] === '--set') {
    const [k, v] = argv[++i].replace(/^p\./, '').split('=');
    overrides[k] = v;
  }
}

const server = await createServer({
  root,
  logLevel: 'error',
  cacheDir: join(tmpdir(), `vite-sweep-${process.pid}`),
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});
const errors = [];
const origError = console.error;
console.error = (...a) => errors.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' '));

try {
  const THREE = await server.ssrLoadModule('three');
  const { loadParts } = await server.ssrLoadModule('/src/gen/parts/index.ts');
  const { generateHouse } = await server.ssrLoadModule('/src/gen/house.ts');
  const { randomParams } = await server.ssrLoadModule('/src/gen/params.ts');
  const { createMaterials } = await server.ssrLoadModule('/src/gen/materials.ts');
  await loadParts();
  const materials = createMaterials();

  let worst = { tris: 0, seed: -1 };
  let totalMs = 0;
  const failures = [];
  for (let seed = start; seed < start + count; seed++) {
    errors.length = 0;
    const p = randomParams(seed);
    for (const [k, v] of Object.entries(overrides)) {
      const cur = p[k];
      p[k] = typeof cur === 'number' ? Number(v) : typeof cur === 'boolean' ? v === '1' || v === 'true' : v;
    }
    const problems = [];
    try {
      const t = Date.now();
      const h = generateHouse(p, materials, { parts });
      totalMs += Date.now() - t;
      if (h.stats.triangles > worst.tris) worst = { tris: h.stats.triangles, seed };
      const box = new THREE.Box3();
      let nan = 0;
      h.group.traverse((o) => {
        if (!o.isMesh) return;
        const a = o.geometry.attributes.position.array;
        for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) nan++;
        o.geometry.computeBoundingBox();
        box.union(o.geometry.boundingBox);
      });
      if (nan) problems.push(`${nan} non-finite vertex coords`);
      const b = h.layout.bounds;
      const slack = 4.5;
      if (box.min.y < -0.6) problems.push(`geometry below ground: min.y=${box.min.y.toFixed(2)}`);
      if (box.max.y > b.max.y + 1.5) problems.push(`geometry too high: max.y=${box.max.y.toFixed(2)} > ${b.max.y.toFixed(2)}`);
      if (box.min.x < b.min.x - slack || box.max.x > b.max.x + slack || box.min.z < b.min.z - slack || box.max.z > b.max.z + slack)
        problems.push(`geometry far outside bounds: ${fmt(box.min)} .. ${fmt(box.max)}`);
      h.group.traverse((o) => o.isMesh && o.geometry.dispose());
    } catch (e) {
      problems.push(`exception: ${e.stack ?? e}`);
    }
    problems.push(...errors.map((e) => `console.error: ${e}`));
    if (problems.length) failures.push({ seed, problems });
  }
  console.log(`swept ${count} houses (seeds ${start}..${start + count - 1})${parts ? ` parts=${parts}` : ''}`);
  console.log(`avg generation ${(totalMs / count).toFixed(0)} ms, max triangles ${(worst.tris / 1000).toFixed(0)}k (seed ${worst.seed})`);
  if (failures.length) {
    console.log(`${failures.length} seeds with problems:`);
    for (const f of failures.slice(0, 25)) {
      console.log(`  seed ${f.seed}:`);
      for (const p of f.problems.slice(0, 4)) console.log(`    ${p.split('\n').slice(0, 4).join('\n    ')}`);
    }
    process.exitCode = 1;
  } else console.log('no problems found');
} finally {
  console.error = origError;
  await server.close();
}

function fmt(v) {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
}
