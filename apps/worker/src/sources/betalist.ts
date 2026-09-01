// BetaList (§8.1). Not built yet.
//
// §8.1 is explicit that the scrapers wait until the pipeline is proven:
// scrapers break quietly and there is no point maintaining eleven of them
// before the premise is known to work. It ships disabled rather than absent
// so /health lists it and nobody has to wonder whether it was forgotten.

import { NotImplementedError, type RawLead, type Source } from '../types';

export const betalist: Source = {
  id: 'betalist',
  name: 'BetaList',
  kind: 'rss',
  enabled: false,
  async sweep(): Promise<RawLead[]> {
    throw new NotImplementedError('betalist');
  },
};
