import { PartBuilder } from '../builder';
import type { PartDef } from '../house';

/** TODO: not implemented yet. */
export const part: PartDef = {
  name: 'timber',
  label: 'Timber framing',
  explode: [0, 0, 0],
  build: () => new PartBuilder('timber'),
};
