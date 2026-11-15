import type { DashboardData } from './model';
import { publicationMonth, monthlyPolicyKey, resolveRules } from './compensation';
export type InitialSetupStatus = {
  allowed: boolean;
  reason: string;
  postCount: number;
  draftCount: number;
};
/** Fail closed: this is a pre-earnings, app-default rate correction, never a ledger migration. */
export function initialSetupStatus(
  data: DashboardData,
  appId: string,
  now: string
): InitialSetupStatus {
  const posts = data.posts.filter((post) => post.app_id === appId);
  const statements = data.statements.filter((statement) => statement.app_id === appId);
  const month = publicationMonth(now);
  const status = {
    postCount: posts.filter((post) => publicationMonth(post.published_at) === month).length,
    draftCount: statements.filter((statement) => statement.month === month).length,
  };
  const deny = (reason: string): InitialSetupStatus => ({ ...status, allowed: false, reason });
  if (!data.apps.some((app) => app.id === appId && !app.archived))
    return deny('Select an active app.');
  if (data.ruleVersions.some((version) => version.app_id === appId && version.scope !== 'app'))
    return deny(
      'Initial activation is unavailable when campaign or creator overrides exist. Use normal versioning.'
    );
  if (
    posts.some(
      (post) =>
        post.eligibility_status === 'accepted' ||
        (post.eligible_views ?? 0) > 0 ||
        !!post.review_evidence ||
        (post.eligibility_status !== 'excluded' && !!post.accepted_by) ||
        !!post.source_erased_at
    )
  )
    return deny(
      'This app has reviewed eligibility or financial source history. Monthly versioning must remain in force.'
    );
  if (
    posts.some(
      (post) =>
        data.accounts.find((account) => account.id === post.account_id)?.ownership !== 'company'
    )
  )
    return deny(
      'Creator-owned or unidentified attributed accounts prevent initial-setup repricing.'
    );
  const postIds = new Set(posts.map((post) => post.id));
  if (
    data.snapshots.some(
      (snapshot) =>
        postIds.has(snapshot.post_id) && snapshot.metric === 'organic_views' && snapshot.views > 0
    )
  )
    return deny(
      'Organic-view evidence exists for this app. Resolve compensation using normal monthly versioning.'
    );
  if (
    statements.some(
      (statement) =>
        statement.status !== 'draft' ||
        statement.base_cents !== 0 ||
        statement.potential_bonus_cents !== 0 ||
        statement.payable_cents !== 0 ||
        statement.capped_cents !== 0 ||
        statement.approved_bonus_cents !== null ||
        statement.lines.length > 0 ||
        !!statement.finalized_at ||
        !!statement.paid_at ||
        !!statement.payment_reference ||
        statement.payment_amount_cents !== null ||
        !!statement.source_redacted_at
    )
  )
    return deny(
      'Earned, approved, finalized, paid or redacted compensation prevents initial activation.'
    );
  const statementIds = new Set(statements.map((statement) => statement.id));
  if (data.adjustments.some((adjustment) => statementIds.has(adjustment.statement_id)))
    return deny('Compensation adjustments already exist. Use normal versioning.');
  const active = resolveRules(data.ruleVersions, appId, '', '', now).rules;
  if (active.cpmMode !== 'progressive')
    return deny('Initial activation supports progressive CPM rates only.');
  if (
    posts.some(
      (post) =>
        publicationMonth(post.published_at) === month &&
        (!post.rules || monthlyPolicyKey(post.rules) !== monthlyPolicyKey(active))
    ) ||
    statements.some(
      (statement) =>
        statement.month === month && monthlyPolicyKey(statement.policy) !== monthlyPolicyKey(active)
    )
  )
    return deny(
      'Current-month test records already have a different monthly policy. Use normal versioning.'
    );
  return {
    ...status,
    allowed: true,
    reason:
      'Only unreviewed company/test content and zero-value, unapproved drafts exist. No earned compensation will be changed.',
  };
}
