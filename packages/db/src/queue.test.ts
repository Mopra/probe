import { describe, expect, it } from 'vitest';
import { prefixedSelect, unprefix } from './queue';

describe('prefixedSelect', () => {
  it('aliases every column with a double underscore prefix', () => {
    expect(prefixedSelect('p', 'p', ['id', 'lead_id'])).toBe(
      'p.id as p__id, p.lead_id as p__lead_id',
    );
  });

  it('lets the table alias and the prefix differ', () => {
    expect(prefixedSelect('ct', 'contact', ['email'])).toBe('ct.email as contact__email');
  });
});

describe('unprefix', () => {
  const flat = {
    p__id: 'proof-1',
    p__status: 'ready',
    l__id: 'lead-1',
    l__status: 'ready',
    ct__email: 'a@b.dev',
  };

  it('extracts one group and strips the prefix', () => {
    expect(unprefix(flat, 'p')).toEqual({ id: 'proof-1', status: 'ready' });
  });

  it('keeps colliding column names apart, which is why the prefix exists', () => {
    expect(unprefix<{ id: string }>(flat, 'l').id).toBe('lead-1');
    expect(unprefix<{ id: string }>(flat, 'p').id).toBe('proof-1');
  });

  it('returns an empty object for an absent prefix', () => {
    expect(unprefix(flat, 'nope')).toEqual({});
  });

  it('preserves null values rather than dropping the key', () => {
    expect(unprefix({ ct__email: null }, 'ct')).toEqual({ email: null });
  });
});
