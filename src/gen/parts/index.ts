import type { PartDef } from '../house';

/**
 * Registry of all house parts, in build order. Each part lives in its own
 * module (`./<name>.ts`, exporting `part`) and only reads the shared layout.
 *
 * Parts are loaded with `loadParts()` and a part that fails to load is
 * reported and skipped instead of taking the whole generator down.
 */
export const PART_ORDER = [
  'foundation',
  'walls',
  'stonework',
  'timber',
  'openings',
  'roof',
  'dormers',
  'chimney',
  'props',
] as const;

export const PARTS: PartDef[] = [];

const modules = import.meta.glob<{ part: PartDef }>('./*.ts');

export async function loadParts(): Promise<PartDef[]> {
  if (PARTS.length) return PARTS;
  const loaded = await Promise.allSettled(PART_ORDER.map((name) => modules[`./${name}.ts`]?.()));
  loaded.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.part) PARTS.push(r.value.part);
    else console.error(`part "${PART_ORDER[i]}" failed to load`, r.status === 'rejected' ? r.reason : 'missing export `part`');
  });
  return PARTS;
}
