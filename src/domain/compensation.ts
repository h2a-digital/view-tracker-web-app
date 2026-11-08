import { provisionalViews } from './tracking';
import Decimal from 'decimal.js';
import type { DashboardData, Post, Rules, RuleVersion, Statement, PayoutLine } from './model';
import { verselRules } from './model';

import { accountingTimezone } from './time';
export const timezone = accountingTimezone;
export function publicationMonth(date: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(date));
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}
export function nextMonthStart(now = new Date()): string {
  const [y, m] = publicationMonth(now.toISOString()).split('-').map(Number);
  const target = Date.UTC(y, m, 1);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(target));
  const n = (key: string) => Number(parts.find((p) => p.type === key)!.value);
  const offset =
    Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - target;
  return new Date(target - offset).toISOString();
}
export function resolveRules(
  versions: RuleVersion[],
  appId: string,
  campaignId: string,
  creatorId: string,
  at: string
): { rules: Rules; ids: string[] } {
  let rules = structuredClone(verselRules);
  const ids: string[] = [];
  for (const scope of ['app', 'campaign', 'creator_app', 'creator_campaign'] as const) {
    const applicable = versions
      .filter(
        (v) =>
          v.scope === scope &&
          v.app_id === appId &&
          v.effective_at <= at &&
          (scope === 'campaign' || scope === 'creator_campaign'
            ? v.campaign_id === campaignId
            : true) &&
          (scope.startsWith('creator') ? v.creator_id === creatorId : true)
      )
      .sort(
        (a, b) =>
          a.effective_at.localeCompare(b.effective_at) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id)
      );
    // Versions hold partial patches; a new version is a replacement for that scope.
    const latest = applicable.at(-1);
    if (latest) {
      rules = { ...rules, ...latest.patch };
      ids.push(latest.id);
    }
  }
  return { rules, ids };
}
export const monthlyKeys = [
  'cpmMode',
  'tiers',
  'flatCpm',
  'bonusPlatforms',
  'monthlyCap',
  'bonusApproval',
] as const;
export function monthlyPolicyKey(rules: Rules): string {
  return JSON.stringify([
    rules.cpmMode,
    rules.cpmMode === 'flat' ? rules.flatCpm : rules.cpmMode === 'progressive' ? rules.tiers : null,
    [...rules.bonusPlatforms].sort(),
    rules.monthlyCap,
    rules.bonusApproval,
  ]);
}
function checked(value: number): number {
  if (!Number.isSafeInteger(value))
    throw new Error(
      'Calculation exceeds safe integer precision. Review the imported counts and rates.'
    );
  return value;
}
export function moneyCents(amount: string): number {
  return new Decimal(amount).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}
export function cpmBonusCents(views: number, rules: Rules): number {
  if (rules.cpmMode === 'disabled') return 0;
  if (rules.cpmMode === 'flat')
    return checked(
      new Decimal(views)
        .div(1000)
        .mul(rules.flatCpm)
        .mul(100)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
        .toNumber()
    );
  let lower = 0;
  let amount = new Decimal(0);
  for (const tier of rules.tiers) {
    const inTier = Math.max(0, Math.min(views, tier.upTo ?? views) - lower);
    amount = amount.add(new Decimal(inTier).div(1000).mul(tier.cpm));
    lower = tier.upTo ?? views;
  }
  return checked(amount.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber());
}
export function fixedCents(post: Post): number {
  if (post.eligibility_status !== 'accepted' || post.eligible_views === null || !post.rules)
    return 0;
  return post.rules.fixedPayments
    .filter((p) => p.platform === post.platform && post.eligible_views! >= p.minimumViews)
    .reduce((sum, p) => sum + moneyCents(p.amount), 0);
}
// Largest remainder allocation ensures campaign/post amounts reconcile exactly.
export function allocate(cents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map((w) => new Decimal(cents).mul(w).div(sum));
  const values = exact.map((v) => v.floor().toNumber());
  let left = cents - values.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, remainder: v.minus(values[i]) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.i - b.i);
  for (const row of order) {
    if (left-- <= 0) break;
    values[row.i]++;
  }
  return values;
}
export function calculateStatement(
  data: DashboardData,
  appId: string,
  creatorId: string,
  month: string,
  policy: Rules,
  approvedBonus: number | null = null
) {
  const posts = data.posts
    .filter(
      (p) =>
        p.app_id === appId &&
        p.creator_id === creatorId &&
        publicationMonth(p.published_at) === month
    )
    .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id));
  const accepted = posts.filter(
    (p) =>
      p.eligibility_status === 'accepted' &&
      p.campaign_id &&
      !data.accounts.find((a) => a.id === p.account_id)?.integration?.payoutsBlocked
  );
  const views = accepted.map((p) =>
    policy.bonusPlatforms.includes(p.platform) ? (p.eligible_views ?? 0) : 0
  );
  const base = accepted.map(fixedCents);
  const baseCents = base.reduce((a, b) => a + b, 0);
  const eligibleViews = checked(views.reduce((a, b) => a + b, 0));
  const potentialBonus = cpmBonusCents(eligibleViews, policy);
  const bonus = policy.bonusApproval ? (approvedBonus ?? 0) : potentialBonus;
  if (bonus < 0 || bonus > potentialBonus)
    throw new Error('Approved bonus must be between zero and the calculated potential bonus.');
  const cap = policy.monthlyCap === null ? Number.MAX_SAFE_INTEGER : moneyCents(policy.monthlyCap);
  const paidBase = Math.min(cap, baseCents);
  const paidBonus = Math.min(Math.max(0, cap - paidBase), bonus);
  const allocatedBase = allocate(paidBase, base);
  const allocatedBonus = allocate(paidBonus, views);
  const lines: PayoutLine[] = accepted.map((p, i) => ({
    postId: p.id,
    campaignId: p.campaign_id!,
    views: views[i],
    baseCents: allocatedBase[i],
    bonusCents: allocatedBonus[i],
  }));
  const fingerprint = JSON.stringify({
    policy,
    posts: posts.map((p) => [
      p.id,
      p.campaign_id,
      p.rules,
      p.eligible_views,
      p.eligibility_status,
      p.review_note,
      p.review_evidence,
    ]),
  });
  return {
    baseCents,
    potentialBonus,
    eligibleViews,
    payableCents: paidBase + paidBonus,
    cappedCents: baseCents + bonus - paidBase - paidBonus,
    lines,
    fingerprint,
    unresolved: posts.filter((p) => !['accepted', 'excluded'].includes(p.eligibility_status))
      .length,
    lastDeadline: posts.reduce(
      (latest, p) => (p.deadline && p.deadline > latest ? p.deadline : latest),
      ''
    ),
  };
}
export function refreshDrafts(data: DashboardData): void {
  for (const statement of data.statements.filter((s) => s.status === 'draft')) {
    let result = calculateStatement(
      data,
      statement.app_id,
      statement.creator_id,
      statement.month,
      statement.policy
    );
    if (result.fingerprint !== statement.fingerprint) {
      statement.approved_bonus_cents = null;
      statement.bonus_note = null;
    }
    result = calculateStatement(
      data,
      statement.app_id,
      statement.creator_id,
      statement.month,
      statement.policy,
      statement.approved_bonus_cents
    );
    Object.assign(statement, {
      fingerprint: result.fingerprint,
      base_cents: result.baseCents,
      potential_bonus_cents: result.potentialBonus,
      payable_cents: result.payableCents,
      capped_cents: result.cappedCents,
      lines: result.lines,
    });
  }
}
export function isLocked(data: DashboardData, post: Post): boolean {
  return data.statements.some(
    (s: Statement) =>
      s.status !== 'draft' &&
      s.app_id === post.app_id &&
      s.creator_id === post.creator_id &&
      s.month === publicationMonth(post.published_at)
  );
}

/** Planning estimate only: public counters inside the window never become payable automatically. */
export function calculateProvisional(
  data: DashboardData,
  appId: string,
  creatorId: string,
  month: string,
  policy: Rules
) {
  const copy = structuredClone(data);
  for (const p of copy.posts)
    if (
      p.app_id === appId &&
      p.creator_id === creatorId &&
      publicationMonth(p.published_at) === month &&
      p.eligibility_status !== 'excluded' &&
      p.eligibility_status !== 'accepted'
    ) {
      p.eligible_views = provisionalViews(data, p);
      p.eligibility_status = 'accepted';
    }
  const base = calculateStatement(copy, appId, creatorId, month, policy);
  return calculateStatement(copy, appId, creatorId, month, policy, base.potentialBonus);
}
