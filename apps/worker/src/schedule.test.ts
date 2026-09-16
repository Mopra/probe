import { describe, expect, it } from 'vitest';
import { cronDays } from './index';

describe('cronDays', () => {
  it('maps the default send days to cron numbering', () => {
    expect(cronDays(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('1,2,3,4,5');
  });

  it('puts Sunday first, where cron wants it', () => {
    expect(cronDays(['sat', 'sun'])).toBe('0,6');
  });

  it('de-duplicates', () => {
    expect(cronDays(['mon', 'mon'])).toBe('1');
  });

  it('falls back to every day rather than an expression cron rejects', () => {
    expect(cronDays([])).toBe('*');
  });
});
