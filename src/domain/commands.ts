import {
  calculateStatement,
  fixedCents,
  isLocked,
  monthlyKeys,
  monthlyPolicyKey,
  nextMonthStart,
  publicationMonth,
  refreshDrafts,
  resolveRules,
} from './compensation';
import { validateEvidence } from './tracking';
import { accountingTimezone } from './time';
import { commandSchema, type Command } from './validation';
import { type DashboardData, type Post, type Snapshot, verselRules } from './model';

function requireValue<T>(value: T | undefined, message = 'Record not found.'): T {
  if (!value) throw new Error(message);
  return value;
}
function interval(start: string, end: string | null) {
  if (end && end <= start) throw new Error('End must be later than start.');
}
function ensureEditable(data: DashboardData, post: Post) {
  if (isLocked(data, post))
    throw new Error('This post belongs to a finalized statement. Use a linked adjustment instead.');
}
function setAttribution(data: DashboardData, post: Post, campaignId: string) {
  const campaign = requireValue(data.campaigns.find((c) => c.id === campaignId));
  const memberships = data.memberships.filter(
    (m) =>
      m.creator_id === post.creator_id &&
      m.campaign_id === campaign.id &&
      m.starts_at <= post.published_at &&
      (!m.ends_at || m.ends_at > post.published_at)
  );
  if (!memberships.length)
    throw new Error('The creator needs a campaign assignment covering publication time.');
  const versions = data.ruleVersions.filter(
    (v) => v.app_id === campaign.app_id && v.scope === 'app' && v.effective_at <= post.published_at
  );
  if (!versions.length)
    throw new Error('No historical app compensation rules exist for this publication date.');
  const resolved = resolveRules(
    data.ruleVersions,
    campaign.app_id,
    campaign.id,
    post.creator_id,
    post.published_at
  );
  post.app_id = campaign.app_id;
  post.campaign_id = campaign.id;
  post.rules = resolved.rules;
  post.rule_version_ids = resolved.ids;
  post.deadline = new Date(
    new Date(post.published_at).getTime() + resolved.rules.windowDays * 86400000
  ).toISOString();
  // A new attribution cannot silently retain financial decisions from the previous campaign.
  post.eligible_views = null;
  post.eligibility_status = 'tracking';
  post.review_note = null;
  post.accepted_by = null;
  post.accepted_at = null;
  const existing = data.statements.find(
    (s) =>
      s.app_id === post.app_id &&
      s.creator_id === post.creator_id &&
      s.month === publicationMonth(post.published_at)
  );
  if (existing && existing.status !== 'draft') {
    post.eligibility_status = 'review';
    post.review_note =
      'Late-discovered post in a finalized month. Use a linked correction for any payment.';
  }
  if (existing && monthlyPolicyKey(existing.policy) !== monthlyPolicyKey(resolved.rules))
    throw new Error('This attribution conflicts with the locked monthly CPM schedule or cap.');
}
function addPost(
  data: DashboardData,
  input: Extract<Command, { type: 'addPost' }>['input'],
  now: string
) {
  const account = requireValue(data.accounts.find((a) => a.id === input.accountId));
  if (account.integration?.sourceErasedAt)
    throw new Error('Register a new account after source erasure.');
  const host = new URL(input.url).hostname.replace(/^www\./, '');
  const hosts = {
    tiktok: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
    instagram: ['instagram.com'],
    youtube: ['youtube.com', 'youtu.be'],
    facebook: ['facebook.com', 'fb.watch'],
  };
  if (!hosts[account.platform].includes(host))
    throw new Error('Post URL does not match the account platform.');
  const parsed = new URL(input.url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Use an HTTPS public post URL without embedded credentials.');
  const native =
    account.platform === 'tiktok'
      ? parsed.pathname.match(/\/video\/(\d+)/)?.[1]
      : account.platform === 'youtube'
        ? host === 'youtu.be'
          ? parsed.pathname.slice(1)
          : parsed.searchParams.get('v') ||
            parsed.pathname.match(/\/(?:shorts|embed)\/([^/]+)/)?.[1]
        : account.platform === 'facebook'
          ? parsed.searchParams.get('v') || parsed.pathname.match(/\/(?:reel|videos)\/(\d+)/)?.[1]
          : undefined;
  if ((account.platform === 'tiktok' || account.platform === 'youtube') && !native)
    throw new Error('Use a full canonical video URL so its native ID can be verified.');
  if (native && native !== input.platformPostId)
    throw new Error('Native platform video ID does not match the post URL.');
  parsed.hostname = host;
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  if (account.platform === 'youtube') {
    parsed.hostname = 'youtube.com';
    parsed.pathname = '/watch';
    parsed.searchParams.set('v', input.platformPostId);
  }
  if (account.platform === 'instagram')
    parsed.pathname = parsed.pathname.replace(/^\/reel\//, '/p/');
  const canonicalUrl = parsed.toString();
  const sameUrl = data.posts.find(
    (p) =>
      p.platform === account.platform &&
      p.url === canonicalUrl &&
      p.platform_post_id !== input.platformPostId
  );
  if (sameUrl) throw new Error('This post URL is already tracked under a different native ID.');
  if (new Date(input.publishedAt).getTime() > new Date(now).getTime())
    throw new Error('Publication time cannot be in the future.');
  const duplicate = data.posts.find(
    (p) => p.platform === account.platform && p.platform_post_id === input.platformPostId
  );
  if (duplicate) {
    if (duplicate.account_id !== account.id)
      throw new Error('This post already belongs to another account.');
    return duplicate;
  }
  const post: Post = {
    id: crypto.randomUUID(),
    account_id: account.id,
    platform: account.platform,
    platform_post_id: input.platformPostId,
    url: canonicalUrl,
    caption: input.caption,
    published_at: input.publishedAt,
    creator_id: account.creator_id,
    campaign_id: null,
    app_id: null,
    rules: null,
    rule_version_ids: [],
    deadline: null,
    eligible_views: null,
    eligibility_status: 'review',
    review_note: null,
    accepted_by: null,
    accepted_at: null,
    deleted: false,
  };
  if (input.campaignId) setAttribution(data, post, input.campaignId);
  else {
    const candidates = [
      ...new Set(
        data.mappings
          .filter(
            (m) =>
              m.account_id === account.id &&
              m.starts_at <= input.publishedAt &&
              (!m.ends_at || m.ends_at > input.publishedAt)
          )
          .map((m) => data.memberships.find((x) => x.id === m.membership_id))
          .filter(
            (m) =>
              m &&
              m.creator_id === account.creator_id &&
              m.starts_at <= input.publishedAt &&
              (!m.ends_at || m.ends_at > input.publishedAt)
          )
          .map((m) => m!.campaign_id)
      ),
    ];
    if (candidates.length === 1) {
      try {
        setAttribution(data, post, candidates[0]);
      } catch (error) {
        post.app_id = null;
        post.campaign_id = null;
        post.rules = null;
        post.deadline = null;
        post.review_note = error instanceof Error ? error.message : 'Attribution needs review.';
      }
    }
  }
  data.posts.push(post);
  return post;
}
export function appendObservation(
  data: DashboardData,
  post: Post,
  snapshot: Snapshot,
  now: string
) {
  if (post.source_erased_at) throw new Error('Erased source cannot receive observations.');
  if (snapshot.observed_at < post.published_at || snapshot.observed_at > now)
    throw new Error('Observation time must be between publication and now.');
  if (snapshot.provider_updated_at && snapshot.provider_updated_at > snapshot.observed_at)
    throw new Error('Provider timestamp cannot be after the observation.');
  if (
    data.snapshots.some(
      (s) =>
        s.post_id === post.id &&
        s.source === snapshot.source &&
        s.metric === snapshot.metric &&
        s.observed_at === snapshot.observed_at &&
        s.views === snapshot.views &&
        s.provenance?.metricName === snapshot.provenance?.metricName &&
        s.provenance?.periodStart === snapshot.provenance?.periodStart
    )
  )
    return;
  data.snapshots.push(snapshot);
  if (isLocked(data, post) || post.eligibility_status === 'excluded' || post.accepted_by) return;
  // Thresholds can be proven with a verified lower bound; exact window totals still need review.
  const qualifies =
    post.deadline &&
    snapshot.observed_at <= post.deadline &&
    snapshot.metric === 'organic_views' &&
    snapshot.quality === 'reported' &&
    snapshot.source === 'api' &&
    post.rules?.fixedPayments.some(
      (p) => p.platform === post.platform && snapshot.views >= p.minimumViews
    );
  if (qualifies)
    post.review_note =
      'Fixed threshold observed inside the window; final eligible view total still requires review.';
  if (post.deadline && now >= post.deadline && post.eligibility_status === 'tracking')
    post.eligibility_status = 'review';
}
export function runCommand(
  initial: DashboardData,
  raw: unknown,
  actor = 'administrator',
  clock = new Date()
): DashboardData {
  const command = commandSchema.parse(raw);
  const data = structuredClone(initial);
  const now = clock.toISOString();
  let entityId = '';
  switch (command.type) {
    case 'createApp': {
      const id = crypto.randomUUID();
      const slug =
        command.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'app';
      data.apps.push({
        id,
        name: command.name,
        slug: `${slug}-${id.slice(0, 6)}`,
        color: command.color,
        archived: false,
      });
      data.ruleVersions.push({
        id: crypto.randomUUID(),
        scope: 'app',
        app_id: id,
        campaign_id: null,
        creator_id: null,
        effective_at: now,
        patch: structuredClone(verselRules),
        created_at: now,
      });
      entityId = id;
      break;
    }
    case 'createCampaign': {
      requireValue(data.apps.find((a) => a.id === command.appId && !a.archived));
      const id = crypto.randomUUID();
      data.campaigns.push({ id, app_id: command.appId, name: command.name, status: 'active' });
      entityId = id;
      break;
    }
    case 'createCreator': {
      const id = crypto.randomUUID();
      data.creators.push({ id, name: command.name, email: command.email, notes: command.notes });
      entityId = id;
      break;
    }
    case 'updateEntity': {
      entityId = command.id;
      if (command.entity === 'app') {
        const app = requireValue(data.apps.find((a) => a.id === command.id));
        app.name = command.name;
        if (command.status) app.archived = command.status === 'archived';
      }
      if (command.entity === 'campaign') {
        const c = requireValue(data.campaigns.find((a) => a.id === command.id));
        c.name = command.name;
        if (command.status) c.status = command.status;
      }
      if (command.entity === 'creator') {
        const c = requireValue(data.creators.find((a) => a.id === command.id));
        Object.assign(c, {
          name: command.name,
          ...(command.email !== undefined ? { email: command.email } : {}),
          ...(command.notes !== undefined ? { notes: command.notes } : {}),
        });
      }
      break;
    }
    case 'assignCreator': {
      requireValue(data.creators.find((c) => c.id === command.creatorId));
      requireValue(data.campaigns.find((c) => c.id === command.campaignId));
      interval(command.startsAt, command.endsAt);
      if (
        data.memberships.some(
          (m) =>
            m.creator_id === command.creatorId &&
            m.campaign_id === command.campaignId &&
            (!m.ends_at || m.ends_at > command.startsAt) &&
            (!command.endsAt || m.starts_at < command.endsAt)
        )
      )
        throw new Error('This creator already has an overlapping campaign assignment.');
      const id = crypto.randomUUID();
      data.memberships.push({
        id,
        creator_id: command.creatorId,
        campaign_id: command.campaignId,
        starts_at: command.startsAt,
        ends_at: command.endsAt,
      });
      entityId = id;
      break;
    }
    case 'registerAccount': {
      if (command.provider === 'direct' && command.platform === 'tiktok')
        throw new Error('TikTok continues to use Zernio.');
      if (
        command.provider === 'direct' &&
        command.platform === 'facebook' &&
        !/^\d+$/.test(command.username)
      )
        throw new Error('Enter the numeric Facebook Page ID for direct tracking.');
      if (command.provider === 'zernio' && command.platform !== 'tiktok')
        throw new Error(
          'This pilot supports Zernio for TikTok only. Select manual / CSV for this platform.'
        );
      if (/[\/\\?#:\s]/.test(command.username))
        throw new Error('Enter the public handle only, without a profile URL or spaces.');
      requireValue(data.creators.find((c) => c.id === command.creatorId));
      const username = command.username.replace(/^@/, '');
      if (
        data.accounts.some(
          (a) =>
            a.platform === command.platform && a.username.toLowerCase() === username.toLowerCase()
        )
      )
        throw new Error('That account is already registered.');
      const id = crypto.randomUUID();
      data.accounts.push({
        id,
        creator_id: command.creatorId,
        platform: command.platform,
        username,
        ownership: command.ownership,
        provider: command.provider,
        provider_account_id: null,
        provider_profile_id: null,
        status: 'registered',
        last_synced_at: null,
        error: null,
      });
      entityId = id;
      break;
    }
    case 'mapAccount': {
      const a = requireValue(data.accounts.find((a) => a.id === command.accountId));
      const m = requireValue(data.memberships.find((m) => m.id === command.membershipId));
      if (m.creator_id !== a.creator_id)
        throw new Error('The account and campaign membership must belong to the same creator.');
      interval(command.startsAt, command.endsAt);
      if (
        command.startsAt < m.starts_at ||
        (m.ends_at && (!command.endsAt || command.endsAt > m.ends_at))
      )
        throw new Error('Account mapping must fit inside the campaign assignment dates.');
      const id = crypto.randomUUID();
      data.mappings.push({
        id,
        account_id: a.id,
        membership_id: m.id,
        starts_at: command.startsAt,
        ends_at: command.endsAt,
      });
      entityId = id;
      break;
    }
    case 'saveRules': {
      requireValue(data.apps.find((a) => a.id === command.appId));
      if (command.scope.includes('campaign')) {
        const c = requireValue(data.campaigns.find((c) => c.id === command.campaignId));
        if (c.app_id !== command.appId) throw new Error('Campaign belongs to another app.');
      } else if (command.campaignId) throw new Error('This scope cannot specify a campaign.');
      if (command.scope.startsWith('creator'))
        requireValue(data.creators.find((c) => c.id === command.creatorId));
      else if (command.creatorId) throw new Error('This scope cannot specify a creator.');
      if (command.scope.includes('campaign') && 'monthlyCap' in command.patch)
        throw new Error('Monthly caps can only be set for an app or creator/app.');
      if (command.effectiveAt < now) throw new Error('Rule versions cannot be backdated.');
      const prior = data.ruleVersions
        .filter(
          (v) =>
            v.scope === command.scope &&
            v.app_id === command.appId &&
            v.campaign_id === command.campaignId &&
            v.creator_id === command.creatorId
        )
        .sort(
          (a, b) =>
            a.effective_at.localeCompare(b.effective_at) || a.created_at.localeCompare(b.created_at)
        )
        .at(-1);
      const changesMonthly = monthlyKeys.some(
        (k) => JSON.stringify(prior?.patch[k]) !== JSON.stringify(command.patch[k])
      );
      if (changesMonthly && command.effectiveAt < nextMonthStart(clock))
        throw new Error(
          'CPM, cap, platform, and approval changes take effect next month. Keep the current monthly settings for an immediate post-rule change.'
        );
      if (
        changesMonthly &&
        command.effectiveAt !==
          nextMonthStart(new Date(new Date(command.effectiveAt).getTime() - 1))
      )
        throw new Error(
          'Monthly policy changes must start at America/New_York midnight on the first day of a future month.'
        );
      const id = crypto.randomUUID();
      data.ruleVersions.push({
        id,
        scope: command.scope,
        app_id: command.appId,
        campaign_id: command.campaignId,
        creator_id: command.creatorId,
        effective_at: command.effectiveAt,
        patch: command.patch,
        created_at: now,
      });
      entityId = id;
      break;
    }
    case 'addPost': {
      entityId = addPost(data, command.input, now).id;
      break;
    }
    case 'addSnapshot': {
      const post = requireValue(data.posts.find((p) => p.id === command.input.postId));
      const i = command.input;
      appendObservation(
        data,
        post,
        {
          id: crypto.randomUUID(),
          post_id: post.id,
          views: i.views,
          metric: i.metric,
          source: i.source,
          observed_at: i.observedAt,
          provider_updated_at: i.providerUpdatedAt,
          evidence: i.evidence || null,
          quality: 'uncertain',
          provider: i.source,
        },
        now
      );
      entityId = post.id;
      break;
    }
    case 'attributePost': {
      const p = requireValue(data.posts.find((p) => p.id === command.postId));
      ensureEditable(data, p);
      setAttribution(data, p, command.campaignId);
      entityId = p.id;
      break;
    }
    case 'reviewPost': {
      const p = requireValue(data.posts.find((p) => p.id === command.postId));
      ensureEditable(data, p);
      if (!p.rules || !p.app_id)
        throw new Error('Assign the post to a campaign before reviewing it.');
      if (command.decision === 'accepted' && p.deadline! > now)
        throw new Error('Wait for the eligibility window to close before accepting final views.');
      if (command.decision === 'accepted') {
        if (p.source_erased_at)
          throw new Error('Erased source cannot support a correction or approval.');
        if (data.accounts.find((a) => a.id === p.account_id)?.integration?.payoutsBlocked)
          throw new Error(
            'This integration is blocked from compensation pending provider policy approval.'
          );
        validateEvidence(p, command.evidence);
      }
      const highest = data.snapshots
        .filter(
          (s) => s.post_id === p.id && s.metric !== 'paid_views' && s.provenance?.kind !== 'daily'
        )
        .reduce((v, s) => Math.max(v, s.views), 0);
      if (command.decision === 'accepted' && command.eligibleViews > highest)
        throw new Error(
          'Accepted views cannot exceed recorded observations. Add evidence and an observation first.'
        );
      p.eligible_views = command.decision === 'excluded' ? 0 : command.eligibleViews;
      p.eligibility_status = command.decision;
      p.review_note = command.note;
      p.review_evidence = command.evidence ?? null;
      p.accepted_by = actor;
      p.accepted_at = now;
      entityId = p.id;
      break;
    }
    case 'importRows': {
      for (const p of command.posts) addPost(data, p, now);
      for (const s of command.snapshots) {
        const p = requireValue(data.posts.find((p) => p.id === s.postId));
        appendObservation(
          data,
          p,
          {
            id: crypto.randomUUID(),
            post_id: p.id,
            views: s.views,
            metric: s.metric,
            source: 'csv',
            observed_at: s.observedAt,
            provider_updated_at: s.providerUpdatedAt,
            evidence: s.evidence || null,
            quality: 'uncertain',
            provider: 'csv',
          },
          now
        );
      }
      break;
    }
    case 'generateStatement': {
      requireValue(data.apps.find((a) => a.id === command.appId));
      requireValue(data.creators.find((c) => c.id === command.creatorId));
      const existing = data.statements.find(
        (s) =>
          s.app_id === command.appId &&
          s.creator_id === command.creatorId &&
          s.month === command.month
      );
      if (existing) {
        entityId = existing.id;
        break;
      }
      const posts = data.posts.filter(
        (p) =>
          p.app_id === command.appId &&
          p.creator_id === command.creatorId &&
          publicationMonth(p.published_at) === command.month &&
          p.rules
      );
      if (!posts.length) throw new Error('No attributed posts exist for this creator and month.');
      const policy = requireValue(posts[0].rules ?? undefined);
      if (posts.some((p) => monthlyPolicyKey(p.rules!) !== monthlyPolicyKey(policy)))
        throw new Error(
          'Conflicting monthly CPM schedules. Resolve campaign/creator overrides before calculation.'
        );
      const id = crypto.randomUUID();
      const result = calculateStatement(
        data,
        command.appId,
        command.creatorId,
        command.month,
        policy
      );
      data.statements.push({
        id,
        app_id: command.appId,
        creator_id: command.creatorId,
        month: command.month,
        accounting_timezone: accountingTimezone,
        policy,
        status: 'draft',
        potential_bonus_cents: result.potentialBonus,
        approved_bonus_cents: null,
        bonus_note: null,
        fingerprint: result.fingerprint,
        base_cents: result.baseCents,
        payable_cents: result.payableCents,
        capped_cents: result.cappedCents,
        lines: result.lines,
        finalized_at: null,
        paid_at: null,
        payment_reference: null,
        payment_amount_cents: null,
      });
      entityId = id;
      break;
    }
    case 'approveBonus': {
      const s = requireValue(
        data.statements.find((s) => s.id === command.statementId && s.status === 'draft')
      );
      const result = calculateStatement(data, s.app_id, s.creator_id, s.month, s.policy);
      if (command.amountCents > result.potentialBonus)
        throw new Error('Approval exceeds the calculated bonus.');
      if (command.amountCents < result.potentialBonus && command.note.trim().length < 5)
        throw new Error('Add a reason for a partial approval or rejection.');
      s.approved_bonus_cents = command.amountCents;
      s.bonus_note = command.note;
      s.fingerprint = result.fingerprint;
      entityId = s.id;
      break;
    }
    case 'finalizeStatement': {
      const target = data.statements.find((s) => s.id === command.statementId);
      if (
        target?.status === 'draft' &&
        data.posts.some(
          (p) =>
            p.app_id === target.app_id &&
            p.creator_id === target.creator_id &&
            publicationMonth(p.published_at) === target.month &&
            p.eligibility_status !== 'excluded' &&
            data.accounts.find((a) => a.id === p.account_id)?.integration?.payoutsBlocked
        )
      )
        throw new Error(
          'Resolve provider policy approval or exclude the affected posts before finalizing.'
        );
      const s = requireValue(data.statements.find((s) => s.id === command.statementId));
      if (s.status !== 'draft') {
        entityId = s.id;
        break;
      }
      const result = calculateStatement(
        data,
        s.app_id,
        s.creator_id,
        s.month,
        s.policy,
        s.approved_bonus_cents
      );
      if (
        data.posts.some(
          (p) =>
            p.creator_id === s.creator_id &&
            !p.app_id &&
            publicationMonth(p.published_at) === s.month
        )
      )
        throw new Error('Assign every unassigned creator post for this publication month first.');
      for (const p of data.posts.filter(
        (p) =>
          p.app_id === s.app_id &&
          p.creator_id === s.creator_id &&
          publicationMonth(p.published_at) === s.month &&
          p.eligibility_status === 'accepted'
      ))
        validateEvidence(p, p.review_evidence ?? undefined);
      if (result.unresolved) throw new Error('Review or exclude every outstanding post first.');
      if (publicationMonth(now) <= s.month || result.lastDeadline > now)
        throw new Error('Finalize in the following month, after every eligibility window closes.');
      if (s.policy.bonusApproval && s.approved_bonus_cents === null && result.potentialBonus > 0)
        throw new Error('Approve or reject the discretionary bonus before finalizing.');
      if (result.fingerprint !== s.fingerprint)
        throw new Error('Inputs changed. Recalculate and approve the current bonus first.');
      Object.assign(s, { status: 'finalized', finalized_at: now });
      entityId = s.id;
      break;
    }
    case 'markPaid': {
      const s = requireValue(data.statements.find((s) => s.id === command.statementId));
      if (s.status === 'paid') {
        if (
          s.payment_reference === command.reference &&
          s.payment_amount_cents === command.amountCents
        )
          break;
        throw new Error('This statement is already paid.');
      }
      if (s.status !== 'finalized') throw new Error('Finalize the statement first.');
      if (command.amountCents !== s.payable_cents)
        throw new Error('The external payment must equal the finalized payable amount.');
      if (command.paidAt > now || command.paidAt < s.finalized_at!)
        throw new Error('Payment date must be between finalization and now.');
      s.status = 'paid';
      s.paid_at = command.paidAt;
      s.payment_reference = command.reference;
      s.payment_amount_cents = command.amountCents;
      entityId = s.id;
      break;
    }
    case 'adjustment': {
      const s = requireValue(
        data.statements.find((s) => s.id === command.statementId && s.status !== 'draft')
      );
      if (s.source_redacted_at)
        throw new Error('Source details were erased; this statement cannot be recalculated.');
      const p = requireValue(
        data.posts.find(
          (p) =>
            p.id === command.postId &&
            p.app_id === s.app_id &&
            p.creator_id === s.creator_id &&
            publicationMonth(p.published_at) === s.month
        )
      );
      if (data.adjustments.some((a) => a.statement_id === s.id && a.status === 'pending'))
        throw new Error('Resolve the existing pending correction first.');
      if (p.source_erased_at)
        throw new Error('Erased source cannot support a correction or approval.');
      if (data.accounts.find((a) => a.id === p.account_id)?.integration?.payoutsBlocked)
        throw new Error('Provider policy approval required before a correction.');
      validateEvidence(p, command.evidence);
      const highest = data.snapshots
        .filter(
          (x) => x.post_id === p.id && x.metric !== 'paid_views' && x.provenance?.kind !== 'daily'
        )
        .reduce((n, x) => Math.max(n, x.views), 0);
      if (command.eligibleViews > highest)
        throw new Error(
          'Corrected views exceed recorded observations. Add supporting evidence first.'
        );
      const corrected = structuredClone(data);
      const prior = data.adjustments
        .filter((a) => a.statement_id === s.id && ['approved', 'paid'].includes(a.status))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const a of prior) {
        const post = corrected.posts.find((p) => p.id === a.post_id)!;
        post.eligible_views = a.eligible_views;
        post.eligibility_status = 'accepted';
      }
      const post = corrected.posts.find((x) => x.id === p.id)!;
      post.eligible_views = command.eligibleViews;
      post.eligibility_status = 'accepted';
      const potential = calculateStatement(
        corrected,
        s.app_id,
        s.creator_id,
        s.month,
        s.policy
      ).potentialBonus;
      // Preserve previously rejected dollars; new bonus dollars still need explicit adjustment approval.
      const bonus = Math.max(
        0,
        Math.min(
          potential,
          (s.approved_bonus_cents ?? (s.policy.bonusApproval ? 0 : s.potential_bonus_cents)) +
            potential -
            s.potential_bonus_cents
        )
      );
      const revised = calculateStatement(
        corrected,
        s.app_id,
        s.creator_id,
        s.month,
        s.policy,
        bonus
      );
      const already = s.payable_cents + prior.reduce((sum, a) => sum + a.proposed_cents, 0);
      const id = crypto.randomUUID();
      data.adjustments.push({
        id,
        statement_id: s.id,
        post_id: p.id,
        eligible_views: command.eligibleViews,
        proposed_cents: revised.payableCents - already,
        evidence: command.evidence,
        status: 'pending',
        note: command.note,
        created_at: now,
        paid_at: null,
        payment_reference: null,
      });
      entityId = id;
      break;
    }
    case 'approveAdjustment': {
      const a = requireValue(
        data.adjustments.find((a) => a.id === command.adjustmentId && a.status === 'pending')
      );
      if (a.source_redacted_at && command.approve)
        throw new Error('Erased evidence cannot be approved.');
      a.status = command.approve ? 'approved' : 'rejected';
      entityId = a.id;
      break;
    }
    case 'payAdjustment': {
      const a = requireValue(data.adjustments.find((a) => a.id === command.adjustmentId));
      if (a.status === 'paid' && a.payment_reference === command.reference) break;
      if (a.status !== 'approved')
        throw new Error('Approve the correction before settling it externally.');
      if (command.paidAt < a.created_at || command.paidAt > now)
        throw new Error('Settlement date must be between correction creation and now.');
      a.status = 'paid';
      a.paid_at = command.paidAt;
      a.payment_reference = command.reference;
      entityId = a.id;
      break;
    }
  }
  // Enforce one monthly policy for every attributed post and every currently scheduled assignment.
  const pool = new Map<string, string>();
  for (const p of data.posts.filter((p) => p.rules && p.app_id)) {
    const key = `${p.app_id}:${p.creator_id}:${publicationMonth(p.published_at)}`;
    const fingerprint = monthlyPolicyKey(p.rules!);
    if (pool.has(key) && pool.get(key) !== fingerprint)
      throw new Error('Conflicting CPM schedules or caps in one app/creator/month.');
    pool.set(key, fingerprint);
  }
  if (['saveRules', 'assignCreator'].includes(command.type)) {
    const times = [
      now,
      ...data.ruleVersions.map((v) => v.effective_at),
      ...data.memberships.map((m) => m.starts_at),
    ].filter((t) => t >= now);
    for (const at of times) {
      const policies = new Map<string, string>();
      for (const m of data.memberships.filter(
        (m) => m.starts_at <= at && (!m.ends_at || m.ends_at > at)
      )) {
        const c = requireValue(data.campaigns.find((c) => c.id === m.campaign_id));
        const r = resolveRules(data.ruleVersions, c.app_id, c.id, m.creator_id, at).rules;
        const key = `${c.app_id}:${m.creator_id}`;
        const fp = monthlyPolicyKey(r);
        if (policies.has(key) && policies.get(key) !== fp)
          throw new Error(
            'This change creates conflicting monthly CPM schedules across campaigns. Use one CPM schedule per app and creator.'
          );
        policies.set(key, fp);
      }
    }
  }
  refreshDrafts(data);
  data.audit.unshift({
    id: crypto.randomUUID(),
    action: command.type,
    entity_id: entityId,
    detail:
      command.type === 'reviewPost'
        ? command.note
        : command.type === 'approveBonus'
          ? command.note
          : `${actor} · ${command.type}`,
    created_at: now,
  });
  return data;
}

export function seedData(now = new Date()): DashboardData {
  const appId = '10000000-0000-4000-8000-000000000001';
  const start = `${now.getUTCFullYear()}-01-01T00:00:00.000Z`;
  return {
    apps: [{ id: appId, name: 'Versel', slug: 'versel', color: '#a78bfa', archived: false }],
    campaigns: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        app_id: appId,
        name: 'Creator partnerships',
        status: 'active',
      },
    ],
    creators: [],
    memberships: [],
    accounts: [],
    mappings: [],
    ruleVersions: [
      {
        id: '30000000-0000-4000-8000-000000000001',
        scope: 'app',
        app_id: appId,
        campaign_id: null,
        creator_id: null,
        effective_at: start,
        patch: structuredClone(verselRules),
        created_at: start,
      },
    ],
    posts: [],
    snapshots: [],
    statements: [],
    audit: [],
    syncRuns: [],
    adjustments: [],
  };
}
export function verifiedBaseCents(data: DashboardData, post: Post): number {
  if (post.eligibility_status === 'excluded') return 0;
  const accepted = fixedCents(post);
  if (accepted) return accepted;
  if (!post.rules || !post.deadline) return 0;
  return post.rules.fixedPayments
    .filter(
      (rule) =>
        rule.platform === post.platform &&
        data.snapshots.some(
          (s) =>
            s.post_id === post.id &&
            s.metric === 'organic_views' &&
            s.quality === 'reported' &&
            s.observed_at <= post.deadline! &&
            s.views >= rule.minimumViews
        )
    )
    .reduce((sum, p) => sum + Math.round(Number(p.amount) * 100), 0);
}
