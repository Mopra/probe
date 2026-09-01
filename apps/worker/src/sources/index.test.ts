import { describe, expect, it } from 'vitest';
import { SOURCES } from './index';
import { NotImplementedError } from '../types';

/** The §8.1 table, verbatim. runSweep upserts every row so /health lists the
 *  directories that are not built yet, which is the whole reason they ship. */
const EXPECTED: Array<{ id: string; kind: string; built: boolean }> = [
  { id: 'show_hn', kind: 'api', built: true },
  { id: 'product_hunt', kind: 'api', built: true },
  { id: 'devhunt', kind: 'scrape', built: false },
  { id: 'uneed', kind: 'scrape', built: false },
  { id: 'fazier', kind: 'scrape', built: false },
  { id: 'tinylaunch', kind: 'scrape', built: false },
  { id: 'peerpush', kind: 'scrape', built: false },
  { id: 'openhunts', kind: 'scrape', built: false },
  { id: 'trustmrr', kind: 'scrape', built: false },
  { id: 'betalist', kind: 'rss', built: false },
  { id: 'launching_next', kind: 'rss', built: false },
];

describe('SOURCES', () => {
  it('lists every directory from §8.1, in order', () => {
    expect(SOURCES.map((s) => s.id)).toEqual(EXPECTED.map((e) => e.id));
  });

  it('uses the access kind from the §8.1 table', () => {
    for (const expected of EXPECTED) {
      const source = SOURCES.find((s) => s.id === expected.id);
      expect(source?.kind).toBe(expected.kind);
    }
  });

  it('gives every source a name', () => {
    for (const source of SOURCES) expect(source.name.length).toBeGreaterThan(0);
  });

  it('ships Show HN enabled', () => {
    expect(SOURCES.find((s) => s.id === 'show_hn')?.enabled).toBe(true);
  });

  it('ships Product Hunt disabled without a token', () => {
    const before = process.env.PRODUCT_HUNT_TOKEN;
    delete process.env.PRODUCT_HUNT_TOKEN;
    try {
      expect(SOURCES.find((s) => s.id === 'product_hunt')?.enabled).toBe(false);
    } finally {
      if (before !== undefined) process.env.PRODUCT_HUNT_TOKEN = before;
    }
  });

  it('ships every unbuilt directory disabled and honest about it', async () => {
    for (const expected of EXPECTED.filter((e) => !e.built)) {
      const source = SOURCES.find((s) => s.id === expected.id);
      expect(source?.enabled).toBe(false);
      await expect(source?.sweep()).rejects.toBeInstanceOf(NotImplementedError);
    }
  });
});
