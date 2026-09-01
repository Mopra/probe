// PLAN.md 8.2 and 9.1. Jurisdiction gating is the legal load-bearing wall, so
// every function here fails toward "unknown", and unknown is blocked.

export type JurisdictionSource = 'tld' | 'imprint' | 'hn_profile' | 'whois' | 'html' | 'none';

export interface JurisdictionGuess {
  country: string | null;
  source: JurisdictionSource;
}

/**
 * ccTLD to ISO 3166-1 alpha-2. Keys carry no leading dot and include the
 * multi-label suffixes that actually appear in the wild ('co.uk', 'com.au').
 *
 * Generic TLDs are deliberately absent: .com .net .org .io .co .app .dev .ai
 * .xyz .sh .me .tech .tv .cc .fm .gg .ly .to .is and friends carry no country
 * signal, and half of them are ccTLDs sold generically. Guessing 'US' from
 * '.com' is exactly the expensive error 8.2 warns about.
 */
export const CCTLD_TO_COUNTRY: Record<string, string> = {
  // Nordics
  dk: 'DK',
  se: 'SE',
  no: 'NO',
  fi: 'FI',
  // EU and EEA
  de: 'DE',
  nl: 'NL',
  be: 'BE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  at: 'AT',
  ch: 'CH',
  li: 'LI',
  pl: 'PL',
  cz: 'CZ',
  sk: 'SK',
  si: 'SI',
  hr: 'HR',
  hu: 'HU',
  ro: 'RO',
  bg: 'BG',
  gr: 'GR',
  pt: 'PT',
  ie: 'IE',
  lu: 'LU',
  mt: 'MT',
  cy: 'CY',
  ee: 'EE',
  lv: 'LV',
  lt: 'LT',
  // Rest of Europe
  uk: 'GB',
  gb: 'GB',
  ua: 'UA',
  rs: 'RS',
  ba: 'BA',
  al: 'AL',
  mk: 'MK',
  md: 'MD',
  by: 'BY',
  tr: 'TR',
  ru: 'RU',
  // Americas
  us: 'US',
  ca: 'CA',
  mx: 'MX',
  br: 'BR',
  ar: 'AR',
  cl: 'CL',
  pe: 'PE',
  uy: 'UY',
  // Asia Pacific
  au: 'AU',
  nz: 'NZ',
  in: 'IN',
  jp: 'JP',
  kr: 'KR',
  cn: 'CN',
  hk: 'HK',
  tw: 'TW',
  sg: 'SG',
  my: 'MY',
  th: 'TH',
  ph: 'PH',
  id: 'ID',
  vn: 'VN',
  // Middle East and Africa
  il: 'IL',
  ae: 'AE',
  sa: 'SA',
  qa: 'QA',
  za: 'ZA',
  ng: 'NG',
  ke: 'KE',
  eg: 'EG',
  ma: 'MA',
  // Multi-label suffixes
  'co.uk': 'GB',
  'org.uk': 'GB',
  'ac.uk': 'GB',
  'gov.uk': 'GB',
  'ltd.uk': 'GB',
  'plc.uk': 'GB',
  'net.uk': 'GB',
  'com.au': 'AU',
  'net.au': 'AU',
  'org.au': 'AU',
  'edu.au': 'AU',
  'co.nz': 'NZ',
  'net.nz': 'NZ',
  'org.nz': 'NZ',
  'com.br': 'BR',
  'net.br': 'BR',
  'com.mx': 'MX',
  'com.ar': 'AR',
  'com.sg': 'SG',
  'com.my': 'MY',
  'com.tr': 'TR',
  'com.cn': 'CN',
  'com.hk': 'HK',
  'com.tw': 'TW',
  'co.za': 'ZA',
  'co.jp': 'JP',
  'or.jp': 'JP',
  'ne.jp': 'JP',
  'co.kr': 'KR',
  'co.in': 'IN',
  'co.il': 'IL',
  'com.pl': 'PL',
  'com.pt': 'PT',
  'com.es': 'ES',
  'com.ua': 'UA',
  'co.at': 'AT',
  'or.at': 'AT',
};

/**
 * Fold a string to lowercase ASCII so every lookup table below can stay ASCII.
 * Diacritics are stripped, and the handful of letters that are not a base
 * letter plus a combining mark get an explicit replacement.
 */
function fold(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd');
}

/**
 * '.dk' to 'DK'. Generic TLDs return null: they carry no country signal, and
 * guessing 'US' from '.com' is the expensive error (8.2).
 */
export function countryFromDomain(domain: string): string | null {
  if (typeof domain !== 'string') return null;
  let host = domain.trim().toLowerCase();
  if (host.length === 0) return null;

  // Tolerate a full URL as well as a bare domain.
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slash = host.indexOf('/');
  if (slash !== -1) host = host.slice(0, slash);
  const at = host.indexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  const colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  while (host.startsWith('.')) host = host.slice(1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0) return null;

  const direct = CCTLD_TO_COUNTRY[host];
  if (direct) return direct;

  const labels = host.split('.');
  for (let take = Math.min(3, labels.length); take >= 1; take -= 1) {
    const suffix = labels.slice(labels.length - take).join('.');
    const hit = CCTLD_TO_COUNTRY[suffix];
    if (hit) return hit;
  }
  return null;
}

const COUNTRY_NAMES: Record<string, string> = {
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  'u.s.a.': 'US',
  'u.s.': 'US',
  'united kingdom': 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  uk: 'GB',
  denmark: 'DK',
  danmark: 'DK',
  germany: 'DE',
  deutschland: 'DE',
  france: 'FR',
  sweden: 'SE',
  sverige: 'SE',
  norway: 'NO',
  norge: 'NO',
  finland: 'FI',
  suomi: 'FI',
  netherlands: 'NL',
  nederland: 'NL',
  'the netherlands': 'NL',
  belgium: 'BE',
  belgie: 'BE',
  belgique: 'BE',
  spain: 'ES',
  espana: 'ES',
  italy: 'IT',
  italia: 'IT',
  austria: 'AT',
  osterreich: 'AT',
  switzerland: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  poland: 'PL',
  polska: 'PL',
  'czech republic': 'CZ',
  czechia: 'CZ',
  slovakia: 'SK',
  slovenia: 'SI',
  croatia: 'HR',
  hungary: 'HU',
  romania: 'RO',
  bulgaria: 'BG',
  greece: 'GR',
  portugal: 'PT',
  ireland: 'IE',
  luxembourg: 'LU',
  malta: 'MT',
  cyprus: 'CY',
  estonia: 'EE',
  latvia: 'LV',
  lithuania: 'LT',
  iceland: 'IS',
  ukraine: 'UA',
  turkey: 'TR',
  turkiye: 'TR',
  canada: 'CA',
  mexico: 'MX',
  brazil: 'BR',
  brasil: 'BR',
  argentina: 'AR',
  chile: 'CL',
  australia: 'AU',
  'new zealand': 'NZ',
  india: 'IN',
  japan: 'JP',
  'south korea': 'KR',
  singapore: 'SG',
  malaysia: 'MY',
  indonesia: 'ID',
  thailand: 'TH',
  philippines: 'PH',
  vietnam: 'VN',
  israel: 'IL',
  'united arab emirates': 'AE',
  'south africa': 'ZA',
  nigeria: 'NG',
  kenya: 'KE',
  'hong kong': 'HK',
  taiwan: 'TW',
  china: 'CN',
};

// US state abbreviations, used only as a whole comma separated token or next
// to a five digit ZIP. 'IN', 'OR' and 'ME' are English words, so they never
// get matched loose in free text.
const US_STATES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'ia', 'id',
  'il', 'in', 'ks', 'ky', 'la', 'ma', 'md', 'me', 'mi', 'mn', 'mo', 'ms', 'mt',
  'nc', 'nd', 'ne', 'nh', 'nj', 'nm', 'nv', 'ny', 'oh', 'ok', 'or', 'pa', 'ri',
  'sc', 'sd', 'tn', 'tx', 'ut', 'va', 'vt', 'wa', 'wi', 'wv', 'wy', 'dc',
]);

const US_STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri',
  'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico',
  'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee',
  'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming', 'district of columbia',
]);

const CITIES: Record<string, string> = {
  sf: 'US',
  sfo: 'US',
  'san francisco': 'US',
  'bay area': 'US',
  'sf bay area': 'US',
  'silicon valley': 'US',
  'palo alto': 'US',
  'mountain view': 'US',
  'menlo park': 'US',
  'san jose': 'US',
  oakland: 'US',
  berkeley: 'US',
  nyc: 'US',
  'new york city': 'US',
  brooklyn: 'US',
  manhattan: 'US',
  boston: 'US',
  seattle: 'US',
  austin: 'US',
  chicago: 'US',
  denver: 'US',
  portland: 'US',
  atlanta: 'US',
  miami: 'US',
  'los angeles': 'US',
  'san diego': 'US',
  'salt lake city': 'US',
  'washington dc': 'US',
  toronto: 'CA',
  vancouver: 'CA',
  montreal: 'CA',
  ottawa: 'CA',
  calgary: 'CA',
  london: 'GB',
  manchester: 'GB',
  edinburgh: 'GB',
  glasgow: 'GB',
  bristol: 'GB',
  leeds: 'GB',
  berlin: 'DE',
  munich: 'DE',
  munchen: 'DE',
  hamburg: 'DE',
  cologne: 'DE',
  koln: 'DE',
  frankfurt: 'DE',
  stuttgart: 'DE',
  leipzig: 'DE',
  paris: 'FR',
  lyon: 'FR',
  marseille: 'FR',
  bordeaux: 'FR',
  amsterdam: 'NL',
  rotterdam: 'NL',
  utrecht: 'NL',
  'the hague': 'NL',
  brussels: 'BE',
  bruxelles: 'BE',
  antwerp: 'BE',
  ghent: 'BE',
  copenhagen: 'DK',
  kobenhavn: 'DK',
  aarhus: 'DK',
  odense: 'DK',
  stockholm: 'SE',
  gothenburg: 'SE',
  goteborg: 'SE',
  malmo: 'SE',
  oslo: 'NO',
  bergen: 'NO',
  helsinki: 'FI',
  espoo: 'FI',
  tampere: 'FI',
  madrid: 'ES',
  barcelona: 'ES',
  valencia: 'ES',
  rome: 'IT',
  roma: 'IT',
  milan: 'IT',
  milano: 'IT',
  turin: 'IT',
  vienna: 'AT',
  wien: 'AT',
  graz: 'AT',
  zurich: 'CH',
  geneva: 'CH',
  basel: 'CH',
  lausanne: 'CH',
  lisbon: 'PT',
  lisboa: 'PT',
  porto: 'PT',
  dublin: 'IE',
  cork: 'IE',
  warsaw: 'PL',
  warszawa: 'PL',
  krakow: 'PL',
  wroclaw: 'PL',
  prague: 'CZ',
  praha: 'CZ',
  brno: 'CZ',
  budapest: 'HU',
  bucharest: 'RO',
  sofia: 'BG',
  zagreb: 'HR',
  ljubljana: 'SI',
  bratislava: 'SK',
  athens: 'GR',
  tallinn: 'EE',
  riga: 'LV',
  vilnius: 'LT',
  reykjavik: 'IS',
  kyiv: 'UA',
  kiev: 'UA',
  istanbul: 'TR',
  ankara: 'TR',
  sydney: 'AU',
  melbourne: 'AU',
  brisbane: 'AU',
  perth: 'AU',
  adelaide: 'AU',
  auckland: 'NZ',
  wellington: 'NZ',
  christchurch: 'NZ',
  bangalore: 'IN',
  bengaluru: 'IN',
  mumbai: 'IN',
  'new delhi': 'IN',
  hyderabad: 'IN',
  pune: 'IN',
  chennai: 'IN',
  tokyo: 'JP',
  osaka: 'JP',
  kyoto: 'JP',
  seoul: 'KR',
  beijing: 'CN',
  shanghai: 'CN',
  shenzhen: 'CN',
  'hong kong': 'HK',
  taipei: 'TW',
  'tel aviv': 'IL',
  jerusalem: 'IL',
  haifa: 'IL',
  dubai: 'AE',
  'abu dhabi': 'AE',
  'sao paulo': 'BR',
  'rio de janeiro': 'BR',
  'mexico city': 'MX',
  'buenos aires': 'AR',
  santiago: 'CL',
  'cape town': 'ZA',
  johannesburg: 'ZA',
  nairobi: 'KE',
  lagos: 'NG',
};

// Registration and tax identifiers. These are the strongest text signal there
// is: a company quotes its own registration number and nobody else's.
const REGISTRATION_SIGNALS: Array<{ pattern: RegExp; country: string }> = [
  { pattern: /\bcvr[\s.:-]*(?:nr\.?|no\.?|number)?\s*\d{8}\b/, country: 'DK' },
  { pattern: /\bcvr[\s.:-]*(?:nr\.?|no\.?|number)\b/, country: 'DK' },
  { pattern: /\bust[\s.-]*id[\s.-]*nr\b/, country: 'DE' },
  { pattern: /\bumsatzsteuer[a-z-]*\b/, country: 'DE' },
  { pattern: /\bsteuernummer\b/, country: 'DE' },
  { pattern: /\bhandelsregister\b/, country: 'DE' },
  { pattern: /\bamtsgericht\b/, country: 'DE' },
  { pattern: /\bhrb\s*\d{3,}\b/, country: 'DE' },
  { pattern: /\bgeschaftsfuhrer\b/, country: 'DE' },
  { pattern: /\bfirmenbuchnummer\b/, country: 'AT' },
  { pattern: /\bcompanies house\b/, country: 'GB' },
  { pattern: /\bregistered in england\b/, country: 'GB' },
  { pattern: /\bcompany (?:no\.?|number|reg\.?(?:istration)?\s*no\.?)\s*:?\s*\d{6,}\b/, country: 'GB' },
  { pattern: /\bsiren\b|\bsiret\b|\brcs\s+[a-z]/, country: 'FR' },
  { pattern: /\bkvk[\s.:-]*(?:nummer|nr\.?|no\.?)?\s*\d{6,}\b/, country: 'NL' },
  { pattern: /\bpartita iva\b/, country: 'IT' },
  { pattern: /\bcodice fiscale\b/, country: 'IT' },
  { pattern: /\borganisationsnummer\b/, country: 'SE' },
  { pattern: /\borganisasjonsnummer\b/, country: 'NO' },
  { pattern: /\by-tunnus\b/, country: 'FI' },
  { pattern: /\bkrs\s*\d{6,}\b|\bnip\s*:?\s*\d{10}\b|\bregon\b/, country: 'PL' },
  { pattern: /\bico\s*:?\s*\d{6,8}\b/, country: 'CZ' },
  { pattern: /\bcif\s*:?\s*[a-z]\d{8}\b/, country: 'ES' },
  { pattern: /\babn\s*:?\s*\d{2}\s?\d{3}\s?\d{3}\s?\d{3}\b/, country: 'AU' },
  { pattern: /\bcnpj\b/, country: 'BR' },
  { pattern: /\bgstin\b/, country: 'IN' },
];

// EU VAT id prefixes. EL is Greece and XI is Northern Ireland, neither of
// which is its own ISO alpha-2 code.
const VAT_PREFIXES: Record<string, string> = {
  at: 'AT', be: 'BE', bg: 'BG', cy: 'CY', cz: 'CZ', de: 'DE', dk: 'DK',
  ee: 'EE', el: 'GR', es: 'ES', fi: 'FI', fr: 'FR', gb: 'GB', hr: 'HR',
  hu: 'HU', ie: 'IE', it: 'IT', lt: 'LT', lu: 'LU', lv: 'LV', mt: 'MT',
  nl: 'NL', pl: 'PL', pt: 'PT', ro: 'RO', se: 'SE', si: 'SI', sk: 'SK',
  xi: 'GB',
};

// Leading phone country codes. '+1' is deliberately absent: it covers both the
// US and Canada, and Canada's CASL is opt-in, so reading '+1' as 'US' would be
// the same class of expensive error as reading '.com' as 'US'.
const DIAL_CODES: Record<string, string> = {
  '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL', '32': 'BE', '33': 'FR',
  '34': 'ES', '36': 'HU', '39': 'IT', '40': 'RO', '41': 'CH', '43': 'AT',
  '44': 'GB', '45': 'DK', '46': 'SE', '47': 'NO', '48': 'PL', '49': 'DE',
  '52': 'MX', '54': 'AR', '55': 'BR', '56': 'CL', '60': 'MY', '61': 'AU',
  '62': 'ID', '63': 'PH', '64': 'NZ', '65': 'SG', '66': 'TH', '81': 'JP',
  '82': 'KR', '84': 'VN', '86': 'CN', '90': 'TR', '91': 'IN', '234': 'NG',
  '254': 'KE', '351': 'PT', '352': 'LU', '353': 'IE', '354': 'IS',
  '356': 'MT', '357': 'CY', '358': 'FI', '359': 'BG', '370': 'LT',
  '371': 'LV', '372': 'EE', '380': 'UA', '385': 'HR', '386': 'SI',
  '420': 'CZ', '421': 'SK', '852': 'HK', '886': 'TW', '966': 'SA',
  '971': 'AE', '972': 'IL', '974': 'QA',
};

// 'DK-2100', 'D-10115', 'CH-8001'. A country prefixed postcode is unambiguous.
const POSTCODE_PREFIXES: Record<string, string> = {
  dk: 'DK', de: 'DE', d: 'DE', a: 'AT', at: 'AT', ch: 'CH', se: 'SE',
  no: 'NO', fi: 'FI', pl: 'PL', cz: 'CZ', sk: 'SK', si: 'SI', hr: 'HR',
  hu: 'HU', it: 'IT', es: 'ES', pt: 'PT', fr: 'FR', be: 'BE', nl: 'NL',
  lu: 'LU', ee: 'EE', lv: 'LV', lt: 'LT', gr: 'GR', ro: 'RO', bg: 'BG',
  mt: 'MT', cy: 'CY', ie: 'IE',
};

function addressSignals(folded: string, out: Set<string>): void {
  // US: a state abbreviation followed by a five digit ZIP.
  const usZip = folded.matchAll(/\b([a-z]{2})[.,]?\s+(\d{5})(?:-\d{4})?\b/g);
  for (const hit of usZip) {
    if (US_STATES.has(hit[1] as string)) out.add('US');
  }
  for (const name of US_STATE_NAMES) {
    if (new RegExp(`\\b${name}[.,]?\\s+\\d{5}\\b`).test(folded)) out.add('US');
  }

  // UK postcode, e.g. 'EC1A 1BB' or 'SW1A 2AA'.
  if (/\b[a-z]{1,2}\d[a-z\d]?\s\d[a-z]{2}\b/.test(folded)) out.add('GB');

  // Canadian postcode, e.g. 'M5V 2T6'.
  if (/\b[a-z]\d[a-z]\s?\d[a-z]\d\b/.test(folded)) out.add('CA');

  // Country prefixed continental postcodes.
  for (const m of folded.matchAll(/\b([a-z]{1,2})-(\d{4,5})\b/g)) {
    const hit = POSTCODE_PREFIXES[m[1] as string];
    if (hit) out.add(hit);
  }
}

function boundary(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`);
}

/**
 * Scans page text for a registered company line, a country name, a postal
 * address shape, or a leading phone country code. Conservative by design: two
 * different countries in the same text means we do not know, and not knowing
 * blocks the lead (9.1).
 */
export function countryFromText(text: string): string | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  const folded = fold(text);
  const strong = new Set<string>();

  for (const signal of REGISTRATION_SIGNALS) {
    if (signal.pattern.test(folded)) strong.add(signal.country);
  }

  const vat = folded.matchAll(
    /\bvat[\s.]*(?:no\.?|number|id|reg\.?|registration)?[\s.:#-]*([a-z]{2})\s?-?\s?\d{6,12}\b/g,
  );
  for (const m of vat) {
    const hit = VAT_PREFIXES[m[1] as string];
    if (hit) strong.add(hit);
  }

  for (const [name, code] of Object.entries(COUNTRY_NAMES)) {
    // 'uk' and 'usa' are short enough that a loose match would fire inside
    // ordinary words, so every name is matched on word boundaries.
    if (boundary(name).test(folded)) strong.add(code);
  }

  addressSignals(folded, strong);

  for (const m of folded.matchAll(/(?:^|[\s(>:,;])\+\s?(\d{1,3})/g)) {
    const digits = m[1] as string;
    for (let len = Math.min(3, digits.length); len >= 1; len -= 1) {
      const hit = DIAL_CODES[digits.slice(0, len)];
      if (hit) {
        strong.add(hit);
        break;
      }
    }
  }

  if (strong.size === 1) return [...strong][0] as string;
  if (strong.size > 1) return null;

  // Weak signals, used only when nothing above fired. An Impressum is a German
  // language legal requirement shared by Germany, Austria and Switzerland. DE
  // is the common case, and since none of the three is allowlisted, a wrong
  // guess between them costs nothing.
  if (/\bimpressum\b/.test(folded)) return 'DE';
  if (/\bmentions legales\b/.test(folded)) return 'FR';
  if (/\bmomsnummer\b|\bhandelsbetingelser\b/.test(folded)) return 'DK';

  return null;
}

/**
 * HN profile 'about' free text, e.g. 'SF', 'San Francisco, CA',
 * 'Berlin, Germany', 'London, UK'.
 */
export function countryFromLocationString(location: string): string | null {
  if (typeof location !== 'string' || location.trim().length === 0) return null;
  const folded = fold(location).replace(/\s+/g, ' ').trim();
  const found = new Set<string>();

  const tokens = folded
    .split(/[,/|\n]+/)
    .map((t) => t.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '').trim())
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    const country = COUNTRY_NAMES[token];
    if (country) {
      found.add(country);
      continue;
    }
    const city = CITIES[token];
    if (city) {
      found.add(city);
      continue;
    }
    if (US_STATES.has(token) || US_STATE_NAMES.has(token)) found.add('US');
  }

  if (found.size === 0) {
    // Nothing matched a whole token, so fall back to a word boundary scan for
    // country and city names only. State abbreviations stay out of this pass:
    // 'in', 'or' and 'me' are English words.
    for (const [name, code] of Object.entries({ ...COUNTRY_NAMES, ...CITIES })) {
      if (boundary(name).test(folded)) found.add(code);
    }
  }

  if (found.size === 1) return [...found][0] as string;
  return null;
}

/**
 * Merges guesses in priority order (first non-null wins) and reports the
 * source that produced it.
 */
export function resolveJurisdiction(guesses: JurisdictionGuess[]): JurisdictionGuess {
  if (!Array.isArray(guesses)) return { country: null, source: 'none' };
  for (const guess of guesses) {
    if (!guess) continue;
    const country = guess.country;
    if (typeof country === 'string' && country.trim().length > 0) {
      return { country: country.trim().toUpperCase(), source: guess.source };
    }
  }
  return { country: null, source: 'none' };
}

/**
 * THE GATE (9.1). Unknown is blocked, never benefit of the doubt, because
 * misclassifying a German or Danish founder as American is the expensive
 * error. Denmark is never allowlisted; the config loader refuses to start if
 * 'DK' appears in the list, and this function would happily let it through if
 * it ever did, so that refusal has to stay where it is.
 */
export function isAllowedJurisdiction(country: string | null, allowed: string[]): boolean {
  if (country === null || country === undefined) return false;
  const c = String(country).trim().toUpperCase();
  if (c.length === 0) return false;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.some((a) => typeof a === 'string' && a.trim().toUpperCase() === c);
}
