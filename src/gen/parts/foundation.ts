import { PartBuilder } from '../builder';
import type { PartDef } from '../house';

/** TODO: not implemented yet. */
export const part: PartDef = {
  name: 'foundation',
  label: 'Foundation',
  explode: [0, 0, 0],
  build: () => new PartBuilder('foundation'),
};
