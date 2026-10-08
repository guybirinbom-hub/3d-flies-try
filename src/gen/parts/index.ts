import type { PartDef } from '../house';

/**
 * Registry of all house parts, in build order. Each part lives in its own
 * module (`./<name>.ts`, exporting `part`) and only reads the shared layout.
 * A part missing its module is reported and skipped (and a part that throws
 * while building is skipped by generateHouse), so one broken detail never
 * takes the whole generator down.
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

// Eager: bundled into the same chunk (the single-file viewer build needs that).
const modules = import.meta.glob<{ part: PartDef }>(['./*.ts', '!./index.ts'], { eager: true });

export async function loadParts(): Promise<PartDef[]> {
  if (PARTS.length) return PARTS;
  for (const name of PART_ORDER) {
    const part = modules[`./${name}.ts`]?.part;
    if (part) PARTS.push(part);
    else console.error(`part "${name}" is missing (expected ./${name}.ts exporting \`part\`)`);
  }
  return PARTS;
}
