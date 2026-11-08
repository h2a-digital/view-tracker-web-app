export const platforms = ['tiktok', 'instagram', 'youtube', 'facebook'] as const;
export type Platform = (typeof platforms)[number];
export type Tier = { upTo: number | null; cpm: string };
export type Rules = {
  windowDays: number;
  fixedPayments: { platform: Platform; amount: string; minimumViews: number }[];
  cpmMode: 'progressive' | 'flat' | 'disabled';
  tiers: Tier[];
  flatCpm: string;
  bonusPlatforms: Platform[];
  monthlyCap: string | null;
  bonusApproval: boolean;
};
export type RulePatch = Partial<Rules>;
export type AppRecord = {
  id: string;
  name: string;
  slug: string;
  color: string;
  archived: boolean;
};
export type Campaign = {
  id: string;
  app_id: string;
  name: string;
  status: 'active' | 'paused' | 'archived';
};
export type Creator = { id: string; name: string; email: string; notes: string };
export type Membership = {
  id: string;
  creator_id: string;
  campaign_id: string;
  starts_at: string;
  ends_at: string | null;
};
export type SocialAccount = {
  id: string;
  creator_id: string;
  platform: Platform;
  username: string;
  ownership: 'company' | 'creator';
  provider: 'manual' | 'zernio';
  provider_account_id: string | null;
  provider_profile_id: string | null;
  status: 'registered' | 'connected' | 'attention' | 'disconnected';
  last_synced_at: string | null;
  error: string | null;
};
export type Mapping = {
  id: string;
  account_id: string;
  membership_id: string;
  starts_at: string;
  ends_at: string | null;
};
export type RuleVersion = {
  id: string;
  scope: 'app' | 'campaign' | 'creator_app' | 'creator_campaign';
  app_id: string;
  campaign_id: string | null;
  creator_id: string | null;
  effective_at: string;
  patch: RulePatch;
  created_at: string;
};
export type Post = {
  id: string;
  account_id: string;
  platform: Platform;
  platform_post_id: string;
  url: string;
  caption: string;
  published_at: string;
  campaign_id: string | null;
  app_id: string | null;
  creator_id: string;
  rules: Rules | null;
  rule_version_ids: string[];
  deadline: string | null;
  eligible_views: number | null;
  eligibility_status: 'tracking' | 'review' | 'accepted' | 'excluded';
  review_note: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  deleted: boolean;
  tracking?: TrackingState | null;
  review_evidence?: ReviewEvidence | null;
};
export type Snapshot = {
  id: string;
  post_id: string;
  views: number;
  metric: 'public_views' | 'organic_views';
  source: 'manual' | 'csv' | 'api';
  observed_at: string;
  provider_updated_at: string | null;
  evidence: string | null;
  quality: 'reported' | 'uncertain';
  provider: string;
};
export type PayoutLine = {
  postId: string;
  campaignId: string;
  views: number;
  baseCents: number;
  bonusCents: number;
};
export type Statement = {
  id: string;
  app_id: string;
  creator_id: string;
  month: string;
  accounting_timezone?: string;
  policy: Rules;
  status: 'draft' | 'finalized' | 'paid';
  potential_bonus_cents: number;
  approved_bonus_cents: number | null;
  bonus_note: string | null;
  fingerprint: string;
  base_cents: number;
  payable_cents: number;
  capped_cents: number;
  lines: PayoutLine[];
  finalized_at: string | null;
  paid_at: string | null;
  payment_reference: string | null;
  payment_amount_cents: number | null;
};
export type Adjustment = {
  id: string;
  statement_id: string;
  post_id: string;
  eligible_views: number;
  proposed_cents: number;
  evidence?: ReviewEvidence | null;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  note: string;
  created_at: string;
  paid_at: string | null;
  payment_reference: string | null;
};
export type AuditEvent = {
  id: string;
  action: string;
  entity_id: string;
  detail: string;
  created_at: string;
};
export type SyncRun = {
  id: string;
  account_id: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  started_at: string;
  finished_at: string | null;
  message: string;
  diagnostics?: SyncDiagnostics | null;
};
export type DashboardData = {
  apps: AppRecord[];
  campaigns: Campaign[];
  creators: Creator[];
  memberships: Membership[];
  accounts: SocialAccount[];
  mappings: Mapping[];
  ruleVersions: RuleVersion[];
  posts: Post[];
  snapshots: Snapshot[];
  statements: Statement[];
  audit: AuditEvent[];
  syncRuns: SyncRun[];
  adjustments: Adjustment[];
};
export const verselRules: Rules = {
  windowDays: 7,
  fixedPayments: [{ platform: 'tiktok', amount: '10', minimumViews: 1000 }],
  cpmMode: 'progressive',
  tiers: [
    { upTo: 100000, cpm: '1.50' },
    { upTo: 500000, cpm: '0.50' },
    { upTo: null, cpm: '0.25' },
  ],
  flatCpm: '1.50',
  bonusPlatforms: ['tiktok', 'instagram', 'youtube'],
  monthlyCap: '3000',
  bonusApproval: true,
};
export function emptyData(): DashboardData {
  return {
    apps: [],
    campaigns: [],
    creators: [],
    memberships: [],
    accounts: [],
    mappings: [],
    ruleVersions: [],
    posts: [],
    snapshots: [],
    statements: [],
    audit: [],
    syncRuns: [],
    adjustments: [],
  };
}

export type ReviewEvidence = {
  reference: string;
  windowStart: string;
  windowEnd: string;
  organicConfirmed: boolean;
  cutoffConfirmed: boolean;
};
export type TrackingState = {
  status: 'active' | 'closing' | 'complete' | 'review';
  issues: string[];
  firstSeenAt: string;
  lastAttemptAt: string | null;
  lastCounterAt: string | null;
  lastProviderAt: string | null;
  lastError: string | null;
  followupUntil: string | null;
  lastViews?: number | null;
  latestInWindow?: { views: number; providerAt: string; observedAt: string } | null;
  provisionalViews: number;
  cutoffVerified: boolean;
};
export type SyncDiagnostics = {
  postsFetched: number;
  newPosts: number;
  countersFetched: number;
  matchedCounters: number;
  snapshotsSaved: number;
  updatedCounters: number;
  freshCounters: number;
  staleCounters: number;
  missingCounters: number;
  skipped: Record<string, number>;
  errors: string[];
  observations: {
    postId: string;
    outcome: string;
    views: number | null;
    providerAt: string | null;
  }[];
};
