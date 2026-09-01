import { describe, expect, it } from 'vitest';
import {
  CCTLD_TO_COUNTRY,
  countryFromDomain,
  countryFromLocationString,
  countryFromText,
  isAllowedJurisdiction,
  resolveJurisdiction,
} from './jurisdiction';

describe('countryFromDomain', () => {
  it('maps the ccTLDs a launch directory actually produces', () => {
    const cases: Array<[string, string]> = [
      ['meterbase.dk', 'DK'],
      ['meterbase.de', 'DE'],
      ['meterbase.se', 'SE'],
      ['meterbase.no', 'NO'],
      ['meterbase.fi', 'FI'],
      ['meterbase.nl', 'NL'],
      ['meterbase.be', 'BE'],
      ['meterbase.fr', 'FR'],
      ['meterbase.es', 'ES'],
      ['meterbase.it', 'IT'],
      ['meterbase.at', 'AT'],
      ['meterbase.ch', 'CH'],
      ['meterbase.pl', 'PL'],
      ['meterbase.cz', 'CZ'],
      ['meterbase.pt', 'PT'],
      ['meterbase.ie', 'IE'],
      ['meterbase.uk', 'GB'],
      ['meterbase.us', 'US'],
      ['meterbase.ca', 'CA'],
      ['meterbase.au', 'AU'],
      ['meterbase.nz', 'NZ'],
      ['meterbase.in', 'IN'],
      ['meterbase.jp', 'JP'],
      ['meterbase.br', 'BR'],
      ['meterbase.mx', 'MX'],
      ['meterbase.sg', 'SG'],
      ['meterbase.il', 'IL'],
      ['meterbase.za', 'ZA'],
    ];
    for (const [domain, country] of cases) {
      expect(countryFromDomain(domain), domain).toBe(country);
    }
  });

  it('handles multi-label suffixes', () => {
    expect(countryFromDomain('meterbase.co.uk')).toBe('GB');
    expect(countryFromDomain('app.meterbase.co.uk')).toBe('GB');
    expect(countryFromDomain('meterbase.com.au')).toBe('AU');
    expect(countryFromDomain('meterbase.co.nz')).toBe('NZ');
    expect(countryFromDomain('meterbase.com.br')).toBe('BR');
    expect(countryFromDomain('meterbase.co.jp')).toBe('JP');
  });

  it('returns null for every generic TLD, because guessing US from .com is the expensive error', () => {
    const generic = [
      'meterbase.com',
      'meterbase.net',
      'meterbase.org',
      'meterbase.io',
      'meterbase.app',
      'meterbase.dev',
      'meterbase.ai',
      'meterbase.co',
      'meterbase.xyz',
      'meterbase.sh',
      'meterbase.me',
      'meterbase.tech',
      'meterbase.tv',
      'meterbase.cc',
      'meterbase.gg',
      'meterbase.ly',
      'meterbase.to',
      'meterbase.is',
      'meterbase.fm',
    ];
    for (const domain of generic) {
      expect(countryFromDomain(domain), domain).toBeNull();
    }
  });

  it('tolerates a full url, a trailing dot, a port and mixed case', () => {
    expect(countryFromDomain('https://WWW.Meterbase.DK/pricing?x=1')).toBe('DK');
    expect(countryFromDomain('meterbase.dk.')).toBe('DK');
    expect(countryFromDomain('meterbase.dk:8443')).toBe('DK');
    expect(countryFromDomain('.dk')).toBe('DK');
  });

  it('returns null for junk', () => {
    expect(countryFromDomain('')).toBeNull();
    expect(countryFromDomain('localhost')).toBeNull();
    expect(countryFromDomain('meterbase')).toBeNull();
  });

  it('exposes only upper case ISO alpha-2 values', () => {
    for (const [key, value] of Object.entries(CCTLD_TO_COUNTRY)) {
      expect(value, key).toMatch(/^[A-Z]{2}$/);
      expect(key).toBe(key.toLowerCase());
    }
  });
});

describe('countryFromText', () => {
  it('reads a Danish CVR number', () => {
    expect(countryFromText('Meterbase ApS, CVR-nr. 41234567, Copenhagen')).toBe('DK');
  });

  it('reads German registration vocabulary', () => {
    expect(countryFromText('Impressum\nUSt-IdNr: DE123456789\nAmtsgericht Berlin HRB 123456')).toBe(
      'DE',
    );
  });

  it('reads a UK company number and a UK postcode', () => {
    expect(countryFromText('Meterbase Ltd, Company No. 09876543')).toBe('GB');
    expect(countryFromText('71-75 Shelton Street, WC2H 9JQ')).toBe('GB');
  });

  it('reads a US state and ZIP', () => {
    expect(countryFromText('548 Market St, San Francisco, CA 94104')).toBe('US');
  });

  it('reads a leading phone country code', () => {
    expect(countryFromText('Call us on +45 70 20 30 40')).toBe('DK');
    expect(countryFromText('Phone: +49 30 123456')).toBe('DE');
  });

  it('does not read +1 as US, because +1 is also Canada', () => {
    expect(countryFromText('Phone: +1 415 555 0100')).toBeNull();
  });

  it('falls back to Impressum only when nothing stronger fired', () => {
    expect(countryFromText('Impressum')).toBe('DE');
  });

  it('returns null when two different countries are mentioned', () => {
    expect(countryFromText('Registered in Germany, offices in France')).toBeNull();
    expect(countryFromText('Meterbase ApS, CVR-nr. 41234567. Company No. 09876543')).toBeNull();
  });

  it('returns null for empty or signal-free text', () => {
    expect(countryFromText('')).toBeNull();
    expect(countryFromText('   ')).toBeNull();
    expect(countryFromText('Usage-based billing for API companies')).toBeNull();
  });
});

describe('countryFromLocationString', () => {
  it('handles the HN about-field shapes', () => {
    expect(countryFromLocationString('SF')).toBe('US');
    expect(countryFromLocationString('San Francisco, CA')).toBe('US');
    expect(countryFromLocationString('Brooklyn, NY')).toBe('US');
    expect(countryFromLocationString('Austin, Texas')).toBe('US');
    expect(countryFromLocationString('Berlin, Germany')).toBe('DE');
    expect(countryFromLocationString('London, UK')).toBe('GB');
    expect(countryFromLocationString('Copenhagen')).toBe('DK');
    expect(countryFromLocationString('Bengaluru, India')).toBe('IN');
    expect(countryFromLocationString('Toronto')).toBe('CA');
  });

  it('folds diacritics', () => {
    expect(countryFromLocationString('Zürich')).toBe('CH');
    expect(countryFromLocationString('München, Deutschland')).toBe('DE');
    expect(countryFromLocationString('København')).toBe('DK');
  });

  it('finds a country inside a sentence', () => {
    expect(countryFromLocationString('currently living in Amsterdam')).toBe('NL');
  });

  it('returns null when the string names two different countries', () => {
    expect(countryFromLocationString('Berlin / New York')).toBeNull();
  });

  it('returns null for a location that carries no country', () => {
    expect(countryFromLocationString('Remote')).toBeNull();
    expect(countryFromLocationString('')).toBeNull();
    expect(countryFromLocationString('the internet')).toBeNull();
  });
});

describe('resolveJurisdiction', () => {
  it('takes the first non-null guess and reports its source', () => {
    expect(
      resolveJurisdiction([
        { country: null, source: 'tld' },
        { country: 'DE', source: 'imprint' },
        { country: 'US', source: 'hn_profile' },
      ]),
    ).toEqual({ country: 'DE', source: 'imprint' });
  });

  it('upper cases and trims the winner', () => {
    expect(resolveJurisdiction([{ country: ' us ', source: 'hn_profile' }])).toEqual({
      country: 'US',
      source: 'hn_profile',
    });
  });

  it('reports none when nothing resolved', () => {
    expect(resolveJurisdiction([])).toEqual({ country: null, source: 'none' });
    expect(
      resolveJurisdiction([
        { country: null, source: 'tld' },
        { country: null, source: 'html' },
      ]),
    ).toEqual({ country: null, source: 'none' });
  });
});

describe('isAllowedJurisdiction, THE GATE', () => {
  const allowed = ['US'];

  it('allows an allowlisted country', () => {
    expect(isAllowedJurisdiction('US', allowed)).toBe(true);
    expect(isAllowedJurisdiction('us', allowed)).toBe(true);
    expect(isAllowedJurisdiction(' Us ', allowed)).toBe(true);
  });

  it('blocks unknown, never benefit of the doubt', () => {
    expect(isAllowedJurisdiction(null, allowed)).toBe(false);
    expect(isAllowedJurisdiction('', allowed)).toBe(false);
    expect(isAllowedJurisdiction('   ', allowed)).toBe(false);
  });

  it('blocks Denmark and Germany on the launch allowlist', () => {
    expect(isAllowedJurisdiction('DK', allowed)).toBe(false);
    expect(isAllowedJurisdiction('DE', allowed)).toBe(false);
    expect(isAllowedJurisdiction('GB', allowed)).toBe(false);
  });

  it('blocks everything when the allowlist is empty', () => {
    expect(isAllowedJurisdiction('US', [])).toBe(false);
  });

  it('gates a Danish domain end to end', () => {
    const guess = resolveJurisdiction([
      { country: countryFromDomain('meterbase.dk'), source: 'tld' },
    ]);
    expect(guess).toEqual({ country: 'DK', source: 'tld' });
    expect(isAllowedJurisdiction(guess.country, allowed)).toBe(false);
  });

  it('gates a .com with no other signal as unknown, and therefore blocked', () => {
    const guess = resolveJurisdiction([
      { country: countryFromDomain('meterbase.com'), source: 'tld' },
      { country: countryFromText('Usage-based billing for API companies'), source: 'html' },
    ]);
    expect(guess).toEqual({ country: null, source: 'none' });
    expect(isAllowedJurisdiction(guess.country, allowed)).toBe(false);
  });

  it('lets a .com through once an HN profile resolves it to the US', () => {
    const guess = resolveJurisdiction([
      { country: countryFromDomain('meterbase.com'), source: 'tld' },
      { country: countryFromLocationString('San Francisco, CA'), source: 'hn_profile' },
    ]);
    expect(guess).toEqual({ country: 'US', source: 'hn_profile' });
    expect(isAllowedJurisdiction(guess.country, allowed)).toBe(true);
  });
});
