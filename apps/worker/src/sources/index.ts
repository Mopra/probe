// The source registry (§8.1).
//
// Order matters only for readability: the two working APIs first, then the
// nine directories that ship disabled until the pipeline is proven. runSweep
// upserts every entry, enabled or not, so the sources table always matches
// the code and /health can list what exists.

import type { Source } from '../types';
import { showHn } from './show-hn';
import { productHunt } from './product-hunt';
import { devhunt } from './devhunt';
import { uneed } from './uneed';
import { fazier } from './fazier';
import { tinylaunch } from './tinylaunch';
import { peerpush } from './peerpush';
import { openhunts } from './openhunts';
import { trustmrr } from './trustmrr';
import { betalist } from './betalist';
import { launchingNext } from './launching-next';

export const SOURCES: Source[] = [
  showHn,
  productHunt,
  devhunt,
  uneed,
  fazier,
  tinylaunch,
  peerpush,
  openhunts,
  trustmrr,
  betalist,
  launchingNext,
];

export { showHn, productHunt };
