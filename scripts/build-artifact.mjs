#!/usr/bin/env node
/**
 * Builds the viewer as ONE self-contained HTML fragment (all JS and CSS
 * inlined, no doctype/html/head/body — the artifact host adds those), for
 * publishing as a claude.ai artifact.
 *
 *   node scripts/build-artifact.mjs [--out path/to/page.html]
 */
import { build } from 'vite';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outFile = argv[0] === '--out' ? resolve(argv[1]) : join(root, 'dist', 'artifact.html');
const outDir = join(tmpdir(), `artifact-build-${process.pid}`);

process.env.ARTIFACT = '1';
await build({
  root,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

const html = readFileSync(join(outDir, 'index.html'), 'utf8');
const assets = readdirSync(join(outDir, 'assets'));
const js = assets.filter((f) => f.endsWith('.js'));
const css = assets.filter((f) => f.endsWith('.css'));
if (js.length !== 1) throw new Error(`expected one JS bundle, got ${js.join(', ')}`);

const script = readFileSync(join(outDir, 'assets', js[0]), 'utf8').replace(/<\/script/gi, '<\\/script');
const style = css.map((f) => readFileSync(join(outDir, 'assets', f), 'utf8')).join('\n');
const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? '<title>Hearthwright</title>';
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '')
  .trim();

const page = `${title}
<style>
${style}
</style>
${body}
<script type="module">
${script}
</script>
`;
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, page);
console.log(`wrote ${outFile} (${(page.length / 1024).toFixed(0)} KB)`);
