#!/usr/bin/env node
/**
 * Headless screenshot / export harness.
 *
 *   node scripts/shoot.mjs [--out shots] [--size 1280x800] [--glb] name="query" [name2="query" ...]
 *
 * Each shot opens the viewer with `?<query>&ui=0` and saves <out>/<name>.png.
 * With --glb it also saves <out>/<name>.glb. Page errors and console errors
 * are printed (and make the exit code non-zero), together with triangle stats.
 *
 * Example:
 *   node scripts/shoot.mjs --out shots/dev iso="cam=iso" door="cam=door" s7="seed=7&cam=iso2"
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let out = 'shots';
let size = [1280, 800];
let glb = false;
const shots = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') out = args[++i];
  else if (a === '--size') size = args[++i].split('x').map(Number);
  else if (a === '--glb') glb = true;
  else if (a.includes('=')) {
    const eq = a.indexOf('=');
    shots.push({ name: a.slice(0, eq), query: a.slice(eq + 1) });
  } else shots.push({ name: a, query: '' });
}
if (!shots.length) shots.push({ name: 'default', query: '' });
mkdirSync(out, { recursive: true });

const server = await createServer({
  root,
  logLevel: 'error',
  cacheDir: join(tmpdir(), `vite-shoot-${process.pid}`),
  server: { port: 0, host: '127.0.0.1' },
});
await server.listen();
const addr = server.httpServer.address();
const base = `http://127.0.0.1:${addr.port}/`;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`);
  });
  for (const shot of shots) {
    problems.length = 0;
    const url = `${base}?${shot.query}${shot.query ? '&' : ''}ui=0`;
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    try {
      await page.waitForFunction(() => window.__app && window.__app.ready, null, { timeout: 120000 });
    } catch {
      console.log(`✗ ${shot.name}: viewer never became ready`);
      for (const p of problems) console.log('   ' + p);
      failed = true;
      continue;
    }
    const renderMs = await page.evaluate(() => window.__app.renderNow());
    const file = join(out, `${shot.name}.png`);
    await page.screenshot({ path: file });
    const stats = await page.evaluate(() => window.__app.stats());
    const tris = stats.reduce((s, h) => s + h.triangles, 0);
    const parts = stats.length === 1 ? Object.entries(stats[0].parts).map(([k, v]) => `${k}:${(v / 1000).toFixed(1)}k`).join(' ') : `${stats.length} houses`;
    console.log(`✓ ${file}  ${(tris / 1000).toFixed(1)}k tris  [${parts}]  gen ${stats.reduce((s, h) => s + h.ms, 0)}ms  render ${Math.round(renderMs)}ms`);
    if (glb) {
      const b64 = await page.evaluate(() => window.__app.exportGLBBase64());
      const gfile = join(out, `${shot.name}.glb`);
      writeFileSync(gfile, Buffer.from(b64, 'base64'));
      console.log(`  ↳ ${gfile} (${(Buffer.byteLength(b64, 'base64') / 1e6).toFixed(2)} MB)`);
    }
    const relevant = problems.filter((p) => !/GPU stall due to ReadPixels|WebGL: CONTEXT_LOST|Automatic fallback to software WebGL/.test(p));
    if (relevant.length) {
      failed = true;
      for (const p of relevant) console.log('   ' + p);
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
