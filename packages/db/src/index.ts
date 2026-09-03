// Barrel for @probe/db. Raw SQL over postgres.js, server side only, service
// role. There is no RLS surface: nothing database-facing ever ships to a
// browser (PLAN.md §4).

export {
  getSql,
  closeSql,
  withTx,
  usesPooler,
  isUniqueViolation,
  UNIQUE_VIOLATION,
  type Tx,
} from './client';

export * from './types';

export {
  buildLeadWhere,
  buildSendWhere,
  clampLimit,
  clampOffset,
  likePattern,
  statusForDropReason,
  MATCHED_OR_BEYOND_DROP_REASONS,
  LIVE_SEND_STATUSES,
  LIVE_SEND_STATUS_SQL,
  type LeadFilter,
  type SendFilter,
  type SqlChunk,
} from './filters';

export { upsertSource, listSources, markSweepOk, markSweepError } from './sources';

export {
  seedCampaigns,
  listCampaigns,
  getCampaignBySlug,
  getCampaign,
  setCampaignPaused,
  pauseAllCampaigns,
  startWarmup,
  type CampaignSeed,
} from './campaigns';

export {
  insertLead,
  getLead,
  getLeadByDomain,
  listLeadsByStatus,
  setLeadJurisdiction,
  setLeadStatus,
  dropLead,
  listLeads,
  listLiveLeads,
  leadsOnUnroutableCampaigns,
  resetLeadToDiscovered,
  countLeads,
  requalifyJurisdictionDrops,
  type NewLead,
  type LeadListItem,
} from './leads';

export { insertContact, getContactForLead } from './contacts';

export {
  isSuppressed,
  suppressedHashes,
  addSuppression,
  listSuppressions,
  eraseByHash,
} from './suppressions';

export {
  createProof,
  getProof,
  getProofForLead,
  duePendingProofs,
  markProofAttempt,
  markProofReady,
  markProofNoProof,
  markProofFailed,
  type ProofAttemptPatch,
} from './proofs';

export {
  listQueue,
  getQueueItem,
  prefixedSelect,
  unprefix,
  type QueueItem,
} from './queue';

export {
  createSend,
  ContactedAlreadyError,
  hasLiveSend,
  getSend,
  getSendByUnsubToken,
  getSendByClickToken,
  getSendBySesMessageId,
  getSendByProviderEmailId,
  claimNextDueSend,
  claimSend,
  releaseSend,
  stuckSendingSends,
  reconcileStuckSends,
  markSendSent,
  setSendProviderMessageId,
  markSendFailed,
  cancelSend,
  sentTodayCount,
  listSends,
  type SendListItem,
} from './sends';

export { insertEvent, listEventsForSend } from './events';

export { getState, setState, bumpCounter } from './state';

export {
  dashboardStats,
  healthStats,
  rollingRates,
  type DashboardStats,
  type HealthStats,
} from './stats';
