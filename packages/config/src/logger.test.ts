import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger';

let out: string[];
let err: string[];
let savedLevel: string | undefined;

beforeEach(() => {
  out = [];
  err = [];
  savedLevel = process.env.LOG_LEVEL;
  delete process.env.LOG_LEVEL;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = savedLevel;
});

function parse(lines: string[]): Record<string, unknown>[] {
  return lines.map((l) => {
    expect(l.endsWith('\n')).toBe(true);
    expect(l.trimEnd()).not.toContain('\n');
    return JSON.parse(l) as Record<string, unknown>;
  });
}

describe('logger', () => {
  it('writes one JSON line per call with ts, level, scope, msg and fields', () => {
    logger('sweep').info('swept', { source: 'show_hn', count: 12 });
    const [rec] = parse(out);
    expect(rec.level).toBe('info');
    expect(rec.scope).toBe('sweep');
    expect(rec.msg).toBe('swept');
    expect(rec.source).toBe('show_hn');
    expect(rec.count).toBe(12);
    expect(typeof rec.ts).toBe('string');
    expect(new Date(rec.ts as string).toISOString()).toBe(rec.ts);
  });

  it('sends errors to stderr and everything else to stdout', () => {
    const log = logger('send');
    log.warn('slow');
    log.error('boom');
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(parse(err)[0].level).toBe('error');
  });

  it('drops debug below the default level and keeps it at LOG_LEVEL=debug', () => {
    logger('x').debug('quiet');
    expect(out).toHaveLength(0);
    process.env.LOG_LEVEL = 'debug';
    logger('x').debug('loud');
    expect(out).toHaveLength(1);
  });

  it('respects LOG_LEVEL=error', () => {
    process.env.LOG_LEVEL = 'error';
    const log = logger('x');
    log.info('a');
    log.warn('b');
    log.error('c');
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
  });

  it('child merges fields, and call fields win', () => {
    const log = logger('generate').child({ lead_id: 'abc', attempt: 1 });
    log.info('calling', { attempt: 2 });
    const [rec] = parse(out);
    expect(rec.lead_id).toBe('abc');
    expect(rec.attempt).toBe(2);
    expect(rec.scope).toBe('generate');
  });

  it('child of a child accumulates', () => {
    logger('a').child({ one: 1 }).child({ two: 2 }).info('m');
    const [rec] = parse(out);
    expect(rec.one).toBe(1);
    expect(rec.two).toBe(2);
  });

  it('serialises Errors instead of emitting {}', () => {
    logger('x').error('failed', { err: new Error('nope') });
    const rec = parse(err)[0];
    expect((rec.err as Record<string, unknown>).message).toBe('nope');
  });

  it('never throws on a circular field', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger('x').info('m', { circular })).not.toThrow();
    expect(parse(out)[0].log_error).toBe('fields were not serialisable');
  });
});
