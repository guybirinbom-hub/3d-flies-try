#!/usr/bin/env node
/**
 * Screenshot the interactive viewer with its control panel (desktop + phone,
 * light + dark). Usage: node scripts/ui-shot.mjs [--out shots/ui] [query]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
let out = 'shots/ui';
let query = 'explode=0';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') out = argv[++i];
  else query = argv[i];
}
mkdirSync(out, { recursive: true });
const server = await createServer({
  root,
  logLevel: 'error',
  cacheDir: join(tmpdir(), `vite-ui-${process.pid}`),
  server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/?${query}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (const [name, vp, scheme] of [
    ['desktop-light', { width: 1360, height: 860 }, 'light'],
    ['desktop-dark', { width: 1360, height: 860 }, 'dark'],
    ['phone-light', { width: 400, height: 820 }, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: vp, colorScheme: scheme });
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    await page.goto(base, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__app && window.__app.ready, null, { timeout: 120000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(out, `${name}.png`) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    console.log(`✓ ${name}${overflow ? ' (HORIZONTAL OVERFLOW)' : ''}${problems.length ? ' errors: ' + problems.join(' | ') : ''}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
