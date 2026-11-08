import { seedData, runCommand } from '@/domain/commands';
export function populatedDocument() {
  const clock = new Date('2026-11-07T12:00:00Z');
  let document = seedData(clock);
  const go = (raw: unknown) => {
    const command = raw as { type: string; postId?: string; evidence?: unknown };
    const p = document.posts.find((p) => p.id === command.postId);
    if (p && ['reviewPost', 'adjustment'].includes(command.type))
      command.evidence = {
        reference: 'Verified original analytics export',
        windowStart: p.published_at,
        windowEnd: p.deadline,
        organicConfirmed: true,
        cutoffConfirmed: true,
      };
    return (document = runCommand(document, command, 'database test administrator', clock));
  };
  const appId = document.apps[0].id,
    campaignId = document.campaigns[0].id;
  go({ type: 'createCreator', name: 'Round trip creator' });
  const creatorId = document.creators[0].id;
  go({ type: 'assignCreator', creatorId, campaignId, startsAt: '2026-01-01T00:00:00Z' });
  go({
    type: 'registerAccount',
    creatorId,
    platform: 'tiktok',
    username: 'roundtrip',
    ownership: 'creator',
    provider: 'zernio',
  });
  const accountId = document.accounts[0].id;
  go({
    type: 'mapAccount',
    accountId,
    membershipId: document.memberships[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'addPost',
    input: {
      accountId,
      platformPostId: '123456789',
      url: 'https://www.tiktok.com/@roundtrip/video/123456789',
      publishedAt: '2026-10-12T12:00:00Z',
      campaignId,
    },
  });
  const postId = document.posts[0].id;
  go({
    type: 'addSnapshot',
    input: {
      postId,
      views: 2000,
      metric: 'organic_views',
      observedAt: '2026-10-19T12:00:00Z',
      evidence: 'Original analytics export',
    },
  });
  go({
    type: 'reviewPost',
    postId,
    decision: 'accepted',
    eligibleViews: 2000,
    note: 'Verified first-seven-day organic export',
  });
  go({ type: 'generateStatement', appId, creatorId, month: '2026-10' });
  const statementId = document.statements[0].id;
  go({
    type: 'approveBonus',
    statementId,
    amountCents: document.statements[0].potential_bonus_cents,
  });
  go({ type: 'finalizeStatement', statementId });
  go({
    type: 'markPaid',
    statementId,
    amountCents: document.statements[0].payable_cents,
    paidAt: clock.toISOString(),
    reference: 'external-bank-1',
  });
  go({
    type: 'adjustment',
    statementId,
    postId,
    eligibleViews: 1000,
    note: 'Corrected original export; preserve original finalized payout',
  });
  document.syncRuns.push({
    id: crypto.randomUUID(),
    account_id: accountId,
    status: 'success',
    started_at: clock.toISOString(),
    finished_at: clock.toISOString(),
    message: 'Test synchronization',
  });
  return document;
}
