// Shared worker types. Owned by the integration pass: both halves of the
// worker import from here rather than redeclaring, so a source module and a
// job can never drift on the shape of a lead.

/** One product as a launch directory reports it, before any normalisation. */
export interface RawLead {
  /** Stable id within that source. Half of (source_id, external_id). */
  external_id: string;
  name: string;
  url: string;
  description: string | null;
  tags: string[];
  launched_at: Date | null;
  /** Whoever posted it, when the directory exposes that. Feeds the §8.3
   *  cascade (an HN profile very often carries an address) and the
   *  jurisdiction guess (a profile location is a real signal). */
  submitter?: {
    handle?: string;
    profile_url?: string;
    location?: string;
  };
}

export interface Source {
  /** Matches sources.id in the database, e.g. 'show_hn'. */
  id: string;
  name: string;
  kind: 'api' | 'rss' | 'scrape';
  /** False for the nine directories from §8.1 that are not built yet. A
   *  disabled source is still seeded into the table so /health lists it. */
  enabled: boolean;
  sweep(): Promise<RawLead[]>;
}

/** Thrown by the stub sources. Isolated per source by runSweep, so an
 *  unimplemented directory can never stop the ones that work. */
export class NotImplementedError extends Error {
  constructor(sourceId: string) {
    super(`source ${sourceId} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** A resolved contact address, before hashing and before the suppression and
 *  contacted-already checks. Never leaves the worker. */
export interface ContactHit {
  email: string;
  first_name: string | null;
  /** 'mailto' | 'hn_profile' | 'ph_maker' | 'security_txt' | 'whois' |
   *  'findymail'. Recorded on the contact row as GDPR provenance (§9.3). */
  method: string;
  /** 0 to 100. Drives nothing automatically today; it is there so the M2
   *  hit-rate measurement (§13) can be read by method and confidence. */
  confidence: number;
}

export interface SweepSummary {
  swept: number;
  inserted: number;
  duplicates: number;
  errors: Array<{ source: string; error: string }>;
}

export interface ResolveSummary {
  considered: number;
  jurisdiction_blocked: number;
  no_match: number;
  matched: number;
  suppressed: number;
  contacted_other_campaign: number;
  no_contact: number;
  resolved: number;
}

export interface GenerateSummary {
  considered: number;
  ready: number;
  pending: number;
  no_proof: number;
  failed: number;
}

export interface SendSummary {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  reason?: string;
}
