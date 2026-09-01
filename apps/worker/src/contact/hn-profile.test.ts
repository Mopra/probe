import { describe, expect, it } from 'vitest';
import { handleFromProfileUrl, isHnProfileUrl, locationFromAbout, parseAbout, profileUrl } from './hn-profile';

const PAGE = `
<html><body><center><table>
<tr><td valign="top">user:</td><td><a href="user?id=priya">priya</a></td></tr>
<tr><td valign="top">created:</td><td>March 3, 2019</td></tr>
<tr><td valign="top">karma:</td><td>1234</td></tr>
<tr><td valign="top">about:</td><td>Building Meterbase.<p>Berlin, Germany<p>priya [at] meterbase [dot] dev</td></tr>
</table></center></body></html>`;

describe('parseAbout', () => {
  it('reads the about cell', () => {
    const about = parseAbout(PAGE);
    expect(about).toContain('Building Meterbase.');
    expect(about).toContain('Berlin, Germany');
  });

  it('returns null when there is no about field', () => {
    expect(parseAbout('<table><tr><td>user:</td><td>priya</td></tr></table>')).toBeNull();
  });

  it('returns null for an empty document', () => {
    expect(parseAbout('')).toBeNull();
  });
});

describe('locationFromAbout', () => {
  it('picks the location shaped line', () => {
    expect(locationFromAbout(parseAbout(PAGE))).toBe('Berlin, Germany');
  });

  it('strips links and addresses from the fallback text', () => {
    const location = locationFromAbout('Founder. https://meterbase.dev priya@meterbase.dev');
    expect(location).not.toContain('http');
    expect(location).not.toContain('@');
  });

  it('returns null for nothing', () => {
    expect(locationFromAbout(null)).toBeNull();
  });
});

describe('profile urls', () => {
  it('round trips a handle', () => {
    const url = profileUrl('priya');
    expect(isHnProfileUrl(url)).toBe(true);
    expect(handleFromProfileUrl(url)).toBe('priya');
  });

  it('does not mistake a personal site for a profile', () => {
    expect(isHnProfileUrl('https://meterbase.dev')).toBe(false);
  });
});
