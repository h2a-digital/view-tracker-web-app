import { describe, it, expect } from 'vitest';
import { runCommand, seedData } from '@/domain/commands';
import {
  allocate,
  cpmBonusCents,
  calculateStatement,
  nextMonthStart,
  publicationMonth,
  resolveRules,
} from '@/domain/compensation';
import { verselRules, type DashboardData } from '@/domain/model';
import { demoWorkspace } from '@/domain/demo';
const clock = new Date('2026-11-07T12:00:00Z');
function fixture() {
  let d = seedData(clock);
  const go = (raw: unknown) => {
    const c = raw as { type: string; postId?: string; evidence?: unknown };
    const p = d.posts.find((p) => p.id === c.postId);
    if (p && ['reviewPost', 'adjustment'].includes(c.type) && !c.evidence)
      c.evidence = {
        reference: 'Test-only verified analytics export',
        windowStart: p.published_at,
        windowEnd: p.deadline,
        organicConfirmed: true,
        cutoffConfirmed: true,
      };
    return (d = runCommand(d, c, 'test administrator', clock));
  };
  go({ type: 'createCreator', name: 'Test Creator' });
  const creatorId = d.creators[0].id,
    appId = d.apps[0].id,
    campaignId = d.campaigns[0].id;
  go({ type: 'assignCreator', creatorId, campaignId, startsAt: '2026-01-01T00:00:00Z' });
  go({
    type: 'registerAccount',
    creatorId,
    platform: 'tiktok',
    username: 'test',
    ownership: 'creator',
    provider: 'manual',
  });
  const accountId = d.accounts[0].id;
  go({
    type: 'mapAccount',
    accountId,
    membershipId: d.memberships[0].id,
    startsAt: '2026-01-01T00:00:00Z',
  });
  go({
    type: 'addPost',
    input: {
      accountId,
      platformPostId: '12345',
      url: 'https://www.tiktok.com/@test/video/12345',
      publishedAt: '2026-10-12T12:00:00Z',
    },
  });
  const postId = d.posts[0].id;
  go({
    type: 'addSnapshot',
    input: {
      postId,
      views: 100000,
      metric: 'public_views',
      observedAt: '2026-10-19T12:00:00Z',
      evidence: 'Export saved',
    },
  });
  return {
    get data() {
      return d;
    },
    go,
    creatorId,
    appId,
    campaignId,
    accountId,
    postId,
  };
}
function accepted() {
  const f = fixture();
  f.go({
    type: 'reviewPost',
    postId: f.postId,
    decision: 'accepted',
    eligibleViews: 100000,
    note: 'Organic export with exact seven-day cutoff reviewed.',
  });
  f.go({ type: 'generateStatement', appId: f.appId, creatorId: f.creatorId, month: '2026-10' });
  return f;
}
describe('USD calculations', () => {
  it.each([
    [0, 0],
    [1000, 150],
    [100000, 15000],
    [500000, 35000],
    [1000000, 47500],
    [100001, 15000],
  ])('progressive %i views -> %i cents', (v, c) => expect(cpmBonusCents(v, verselRules)).toBe(c));
  it('supports flat and disabled bonuses', () => {
    expect(cpmBonusCents(12345, { ...verselRules, cpmMode: 'flat', flatCpm: '2' })).toBe(2469);
    expect(cpmBonusCents(12345, { ...verselRules, cpmMode: 'disabled' })).toBe(0);
  });
  it('reconciles largest remainder allocations', () => {
    expect(allocate(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocate(0, [1, 4])).toEqual([0, 0]);
  });
  it('assigns publication months and cutoff dates in Rome across DST', () => {
    expect(publicationMonth('2026-10-31T23:30:00Z')).toBe('2026-10');
    expect(nextMonthStart(new Date('2026-02-15T10:00:00Z'))).toBe('2026-03-01T05:00:00.000Z');
    expect(nextMonthStart(new Date('2026-06-15T10:00:00Z'))).toBe('2026-07-01T04:00:00.000Z');
  });
});
describe('post and eligibility ledger', () => {
  it('routes once, freezes rules, and deduplicates discovery', () => {
    const f = fixture();
    expect(f.data.posts[0].campaign_id).toBe(f.campaignId);
    expect(f.data.posts[0].deadline).toBe('2026-10-19T12:00:00.000Z');
    f.go({
      type: 'addPost',
      input: {
        accountId: f.accountId,
        platformPostId: '12345',
        url: 'https://www.tiktok.com/@test/video/12345',
        publishedAt: '2026-10-12T12:00:00Z',
      },
    });
    expect(f.data.posts).toHaveLength(1);
  });
  it('does not mistake public counters for payable organic views', () => {
    const f = fixture();
    f.go({ type: 'generateStatement', appId: f.appId, creatorId: f.creatorId, month: '2026-10' });
    expect(f.data.statements[0].payable_cents).toBe(0);
    expect(f.data.posts[0].eligible_views).toBeNull();
    expect(() => f.go({ type: 'finalizeStatement', statementId: f.data.statements[0].id })).toThrow(
      /Review or exclude/
    );
  });
  it('blocks premature acceptance and impossible totals', () => {
    const f = fixture();
    expect(() =>
      f.go({
        type: 'reviewPost',
        postId: f.postId,
        decision: 'accepted',
        eligibleViews: 100001,
        note: 'Reviewed evidence',
      })
    ).toThrow(/exceed/);
    const p = f.data.posts[0];
    p.deadline = '2026-12-01T00:00:00.000Z';
    expect(() =>
      f.go({
        type: 'reviewPost',
        postId: f.postId,
        decision: 'accepted',
        eligibleViews: 999,
        note: 'Reviewed evidence',
      })
    ).toThrow(/window/);
  });
  it('normalizes offset dates before interval comparisons', () => {
    const f = fixture();
    f.go({
      type: 'addSnapshot',
      input: {
        postId: f.postId,
        views: 1500,
        metric: 'public_views',
        observedAt: '2026-10-13T14:00:00+02:00',
      },
    });
    expect(f.data.snapshots.at(-1)?.observed_at).toBe('2026-10-13T12:00:00.000Z');
  });
  it('rejects invalid platform URLs and future observations atomically', () => {
    const f = fixture();
    expect(() =>
      f.go({
        type: 'addPost',
        input: {
          accountId: f.accountId,
          platformPostId: 'other',
          url: 'https://evil.example/video/1',
          publishedAt: '2026-10-12T12:00:00Z',
        },
      })
    ).toThrow(/platform/);
    expect(f.data.posts).toHaveLength(1);
    expect(() =>
      f.go({
        type: 'addSnapshot',
        input: {
          postId: f.postId,
          views: 1000,
          metric: 'public_views',
          observedAt: '2027-01-01T00:00:00Z',
        },
      })
    ).toThrow(/between/);
  });
  it('holds ambiguous campaign mappings for attribution', () => {
    const f = fixture();
    f.go({ type: 'createCampaign', appId: f.appId, name: 'Other campaign' });
    const other = f.data.campaigns.at(-1)!.id;
    f.go({
      type: 'assignCreator',
      creatorId: f.creatorId,
      campaignId: other,
      startsAt: '2026-01-01T00:00:00Z',
    });
    f.go({
      type: 'mapAccount',
      accountId: f.accountId,
      membershipId: f.data.memberships.at(-1)!.id,
      startsAt: '2026-01-01T00:00:00Z',
    });
    f.go({
      type: 'addPost',
      input: {
        accountId: f.accountId,
        platformPostId: '67890',
        url: 'https://www.tiktok.com/@test/video/67890',
        publishedAt: '2026-10-14T12:00:00Z',
      },
    });
    expect(f.data.posts.at(-1)?.app_id).toBeNull();
  });
});
describe('statement lifecycle', () => {
  it('keeps discretionary bonuses out until approved; supports partial approval', () => {
    const f = accepted(),
      id = f.data.statements[0].id;
    expect(f.data.statements[0].payable_cents).toBe(1000);
    expect(f.data.statements[0].potential_bonus_cents).toBe(15000);
    f.go({
      type: 'approveBonus',
      statementId: id,
      amountCents: 7500,
      note: 'Partial discretionary approval',
    });
    expect(f.data.statements[0].payable_cents).toBe(8500);
  });
  it('clears approval when eligibility inputs change', () => {
    const f = accepted(),
      id = f.data.statements[0].id;
    f.go({ type: 'approveBonus', statementId: id, amountCents: 15000 });
    f.go({
      type: 'reviewPost',
      postId: f.postId,
      decision: 'accepted',
      eligibleViews: 50000,
      note: 'Corrected reviewed organic export',
    });
    expect(f.data.statements[0].approved_bonus_cents).toBeNull();
    expect(f.data.statements[0].payable_cents).toBe(1000);
  });
  it('prioritizes fixed payments within the shared monthly cap', () => {
    const f = accepted();
    const r = calculateStatement(
      f.data,
      f.appId,
      f.creatorId,
      '2026-10',
      { ...verselRules, monthlyCap: '15' },
      15000
    );
    expect(r.payableCents).toBe(1500);
    expect(r.lines[0]).toMatchObject({ baseCents: 1000, bonusCents: 500 });
    expect(r.cappedCents).toBe(14500);
  });
  it('finalizes only reviewed inputs, records exact payment, and prevents repeat payment', () => {
    const f = accepted(),
      id = f.data.statements[0].id;
    expect(() => f.go({ type: 'finalizeStatement', statementId: id })).toThrow(/Approve or reject/);
    f.go({ type: 'approveBonus', statementId: id, amountCents: 15000 });
    f.go({ type: 'finalizeStatement', statementId: id });
    expect(() =>
      f.go({
        type: 'reviewPost',
        postId: f.postId,
        decision: 'excluded',
        eligibleViews: 0,
        note: 'Correction after finalization',
      })
    ).toThrow(/finalized/);
    expect(() =>
      f.go({
        type: 'markPaid',
        statementId: id,
        amountCents: 1,
        paidAt: clock.toISOString(),
        reference: 'bank-1',
      })
    ).toThrow(/equal/);
    f.go({
      type: 'markPaid',
      statementId: id,
      amountCents: 16000,
      paidAt: clock.toISOString(),
      reference: 'bank-1',
    });
    f.go({
      type: 'markPaid',
      statementId: id,
      amountCents: 16000,
      paidAt: clock.toISOString(),
      reference: 'bank-1',
    });
    expect(f.data.statements).toHaveLength(1);
    expect(f.data.statements[0].status).toBe('paid');
  });
  it('corrects a finalized month using an approved separate recovery ledger', () => {
    const f = accepted(),
      id = f.data.statements[0].id;
    f.go({ type: 'approveBonus', statementId: id, amountCents: 15000 });
    f.go({ type: 'finalizeStatement', statementId: id });
    const original = structuredClone(f.data.statements[0]);
    f.go({
      type: 'adjustment',
      statementId: id,
      postId: f.postId,
      eligibleViews: 0,
      note: 'Paid traffic discovered in evidence review',
    });
    expect(f.data.adjustments[0].proposed_cents).toBe(-16000);
    expect(f.data.adjustments[0].status).toBe('pending');
    expect(f.data.statements[0]).toEqual(original);
    f.go({ type: 'approveAdjustment', adjustmentId: f.data.adjustments[0].id, approve: true });
    f.go({
      type: 'payAdjustment',
      adjustmentId: f.data.adjustments[0].id,
      reference: 'refund-1',
      paidAt: clock.toISOString(),
    });
    expect(f.data.adjustments[0].status).toBe('paid');
  });
});
describe('versioning', () => {
  it('resolves inheritance, replacement patches, and explicit zero', () => {
    const f = fixture();
    const versions = f.data.ruleVersions;
    versions.push({
      id: 'override',
      scope: 'creator_app',
      app_id: f.appId,
      campaign_id: null,
      creator_id: f.creatorId,
      effective_at: '2026-01-02T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      patch: { monthlyCap: '0', windowDays: 14 },
    });
    expect(
      resolveRules(versions, f.appId, f.campaignId, f.creatorId, '2026-02-01T00:00:00.000Z').rules
    ).toMatchObject({ windowDays: 14, monthlyCap: '0' });
    versions.push({
      ...versions.at(-1)!,
      id: 'inherit',
      effective_at: '2026-03-01T00:00:00.000Z',
      patch: {},
    });
    expect(
      resolveRules(versions, f.appId, f.campaignId, f.creatorId, '2026-04-01T00:00:00.000Z').rules
        .windowDays
    ).toBe(7);
  });
  it('rejects backdating and midmonth CPM changes', () => {
    const f = fixture();
    expect(() =>
      f.go({
        type: 'saveRules',
        scope: 'app',
        appId: f.appId,
        campaignId: null,
        creatorId: null,
        effectiveAt: '2026-11-08T00:00:00Z',
        patch: { ...verselRules, flatCpm: '5' },
      })
    ).toThrow(/next month/);
    expect(() =>
      f.go({
        type: 'saveRules',
        scope: 'app',
        appId: f.appId,
        campaignId: null,
        creatorId: null,
        effectiveAt: '2026-10-01T00:00:00Z',
        patch: verselRules,
      })
    ).toThrow(/backdated/);
  });
  it('permits an immediate fixed-payment change without rewriting existing posts', () => {
    const f = fixture();
    f.go({
      type: 'saveRules',
      scope: 'app',
      appId: f.appId,
      campaignId: null,
      creatorId: null,
      effectiveAt: '2026-11-08T00:00:00Z',
      patch: {
        ...verselRules,
        fixedPayments: [{ platform: 'tiktok', amount: '20', minimumViews: 1000 }],
      },
    });
    expect(f.data.posts[0].rules?.fixedPayments[0].amount).toBe('10');
  });
  it('refuses campaign caps', () => {
    const f = fixture();
    expect(() =>
      f.go({
        type: 'saveRules',
        scope: 'campaign',
        appId: f.appId,
        campaignId: f.campaignId,
        creatorId: null,
        effectiveAt: '2026-12-01T00:00:00Z',
        patch: { monthlyCap: '100' },
      })
    ).toThrow(/app or creator/);
  });
  it('keeps preview sample records separate from empty setup', () => {
    const d: DashboardData = demoWorkspace();
    expect(d.creators).toHaveLength(3);
    expect(d.statements).toHaveLength(3);
    expect(seedData().creators).toHaveLength(0);
  });
});

describe('future scheduling and late discovery', () => {
  it('rejects midmonth future CPM starts, even when after next month', () => {
    const f = fixture();
    expect(() =>
      f.go({
        type: 'saveRules',
        scope: 'app',
        appId: f.appId,
        campaignId: null,
        creatorId: null,
        effectiveAt: '2026-12-15T00:00:00Z',
        patch: { ...verselRules, flatCpm: '3' },
      })
    ).toThrow(/first day/);
  });
  it('supports a newly found post in a finalized pool through linked corrections', () => {
    const f = accepted(),
      id = f.data.statements[0].id;
    f.go({ type: 'approveBonus', statementId: id, amountCents: 15000 });
    f.go({ type: 'finalizeStatement', statementId: id });
    const original = structuredClone(f.data.statements[0]);
    f.go({
      type: 'addPost',
      input: {
        accountId: f.accountId,
        platformPostId: '99999',
        url: 'https://www.tiktok.com/@test/video/99999',
        publishedAt: '2026-10-13T12:00:00Z',
      },
    });
    const late = f.data.posts.at(-1)!;
    expect(late.app_id).toBe(f.appId);
    expect(late.review_note).toContain('Late-discovered');
    f.go({
      type: 'addSnapshot',
      input: {
        postId: late.id,
        views: 2000,
        metric: 'organic_views',
        observedAt: '2026-10-20T12:00:00Z',
        evidence: 'Reviewed original analytics export',
      },
    });
    f.go({
      type: 'adjustment',
      statementId: id,
      postId: late.id,
      eligibleViews: 2000,
      note: 'Original export proves missing video and eligible views',
    });
    expect(f.data.adjustments[0].proposed_cents).toBe(1100);
    expect(f.data.statements[0]).toEqual(original);
  });
  it('rejects numeric overflow rather than silently rounding payout money', () => {
    expect(() =>
      cpmBonusCents(Number.MAX_SAFE_INTEGER, {
        ...verselRules,
        cpmMode: 'flat',
        flatCpm: '1000000000',
      })
    ).toThrow(/precision/);
  });
});

it('rejects inconsistent TikTok native IDs so URL aliases cannot duplicate payment', () => {
  const f = fixture();
  expect(() =>
    f.go({
      type: 'addPost',
      input: {
        accountId: f.accountId,
        platformPostId: 'different-id',
        url: 'https://www.tiktok.com/@test/video/12345?tracking=1',
        publishedAt: '2026-10-12T12:00:00Z',
      },
    })
  ).toThrow(/does not match/);
  expect(f.data.posts).toHaveLength(1);
});
