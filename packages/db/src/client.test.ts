import { describe, expect, it } from 'vitest';
import { first, isUniqueViolation, rows, UNIQUE_VIOLATION, usesPooler } from './client';

describe('usesPooler', () => {
  it('detects the Supabase transaction pooler host', () => {
    expect(
      usesPooler('postgres://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'),
    ).toBe(true);
  });

  it('is false for a direct connection', () => {
    expect(usesPooler('postgres://postgres:pw@db.abcdef.supabase.co:5432/postgres')).toBe(false);
    expect(usesPooler('postgres://postgres:pw@localhost:5432/probe')).toBe(false);
  });

  it('does not look at the path or the credentials', () => {
    // A database named 'pooler' is not a pooler, and neither is a password
    // that happens to contain the word.
    expect(usesPooler('postgres://postgres:pw@localhost:5432/pooler')).toBe(false);
    expect(usesPooler('postgres://user:pooler@localhost:5432/probe')).toBe(false);
  });

  it('is case insensitive on the host', () => {
    expect(usesPooler('postgres://u:p@AWS-0.POOLER.supabase.com:6543/postgres')).toBe(true);
  });

  it('falls back to a substring check on an unparseable url', () => {
    expect(usesPooler('not a url but mentions pooler')).toBe(true);
    expect(usesPooler('not a url')).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('recognises code 23505', () => {
    expect(UNIQUE_VIOLATION).toBe('23505');
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('is false for any other error', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('matches a named constraint', () => {
    const err = { code: '23505', constraint_name: 'sends_email_hash_uniq' };
    expect(isUniqueViolation(err, 'sends_email_hash_uniq')).toBe(true);
    expect(isUniqueViolation(err, 'sends_unsub_token_key')).toBe(false);
  });

  it('accepts either constraint field name', () => {
    expect(
      isUniqueViolation({ code: '23505', constraint: 'sends_email_hash_uniq' }, 'sends_email_hash_uniq'),
    ).toBe(true);
  });
});

describe('row helpers', () => {
  it('first returns null on an empty result', () => {
    expect(first<{ n: number }>([])).toBeNull();
    expect(first<{ n: number }>([{ n: 3 }])).toEqual({ n: 3 });
  });

  it('rows passes the array through', () => {
    const input = [{ id: 'a' }, { id: 'b' }];
    expect(rows<{ id: string }>(input)).toBe(input);
  });
});
