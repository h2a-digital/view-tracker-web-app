import { z } from 'zod';
import { platforms } from './model';
import { instantSchema } from './time';
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'Use a positive decimal amount.')
  .refine((v) => Number(v) <= 1e9, 'Amount too large.');
export const rulePatchSchema = z
  .object({
    windowDays: z.number().positive().max(365),
    fixedPayments: z
      .array(
        z.object({
          platform: z.enum(platforms),
          amount,
          minimumViews: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
      )
      .refine(
        (v) => new Set(v.map((p) => p.platform)).size === v.length,
        'Use one fixed payment per platform.'
      ),
    cpmMode: z.enum(['progressive', 'flat', 'disabled']),
    tiers: z.array(
      z.object({
        upTo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
        cpm: amount,
      })
    ),
    flatCpm: amount,
    bonusPlatforms: z.array(z.enum(platforms)).refine((v) => new Set(v).size === v.length),
    monthlyCap: amount.nullable(),
    bonusApproval: z.boolean(),
  })
  .partial()
  .strict()
  .superRefine((v, ctx) => {
    if (v.tiers) {
      const tiers = v.tiers;
      if (
        !tiers.length ||
        tiers.at(-1)?.upTo !== null ||
        tiers.some(
          (t, i) =>
            i < tiers.length - 1 &&
            (t.upTo === null || (i > 0 && t.upTo <= (tiers[i - 1].upTo ?? Infinity)))
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Progressive tiers must increase and end with an unlimited tier.',
          path: ['tiers'],
        });
    }
  });
const id = z.string().min(1).max(200);
const date = instantSchema;
const evidence = z.object({
  reference: z.string().trim().min(10).max(4000),
  windowStart: date,
  windowEnd: date,
  organicConfirmed: z.boolean(),
  cutoffConfirmed: z.boolean(),
  shortsConfirmed: z.boolean().optional(),
});
export const postInputSchema = z
  .object({
    accountId: id,
    platformPostId: id,
    url: z.url().max(2000),
    caption: z.string().max(10000).default(''),
    publishedAt: date,
    campaignId: id.nullable().default(null),
  })
  .strict();
export const snapshotInputSchema = z
  .object({
    postId: id,
    views: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    metric: z.enum(['public_views', 'organic_views', 'paid_views', 'uncertain_views']),
    observedAt: date,
    providerUpdatedAt: date.nullable().default(null),
    evidence: z.string().max(4000).default(''),
    source: z.enum(['manual', 'csv']).default('manual'),
  })
  .strict();
export const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('createApp'),
    name: z.string().trim().min(1).max(100),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#9b8afb'),
  }),
  z.object({
    type: z.literal('createCampaign'),
    appId: id,
    name: z.string().trim().min(1).max(100),
  }),
  z.object({
    type: z.literal('createCreator'),
    name: z.string().trim().min(1).max(100),
    email: z.union([z.email(), z.literal('')]).default(''),
    notes: z.string().max(2000).default(''),
  }),
  z.object({
    type: z.literal('updateEntity'),
    entity: z.enum(['app', 'campaign', 'creator']),
    id,
    name: z.string().trim().min(1).max(100),
    status: z.enum(['active', 'paused', 'archived']).optional(),
    email: z.union([z.email(), z.literal('')]).optional(),
    notes: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal('assignCreator'),
    creatorId: id,
    campaignId: id,
    startsAt: date,
    endsAt: date.nullable().default(null),
  }),
  z.object({
    type: z.literal('registerAccount'),
    creatorId: id,
    platform: z.enum(platforms),
    username: z.string().trim().min(1).max(100),
    ownership: z.enum(['company', 'creator']),
    provider: z.enum(['manual', 'zernio', 'direct']),
  }),
  z.object({
    type: z.literal('mapAccount'),
    accountId: id,
    confirmCompanyCompensation: z.boolean().default(false),
    membershipId: id,
    startsAt: date,
    endsAt: date.nullable().default(null),
  }),
  z.object({
    type: z.literal('saveRules'),
    scope: z.enum(['app', 'campaign', 'creator_app', 'creator_campaign']),
    appId: id,
    campaignId: id.nullable(),
    creatorId: id.nullable(),
    effectiveAt: date,
    patch: rulePatchSchema,
  }),
  z.object({ type: z.literal('addPost'), input: postInputSchema }),
  z.object({ type: z.literal('addSnapshot'), input: snapshotInputSchema }),
  z.object({ type: z.literal('attributePost'), postId: id, campaignId: id }),
  z.object({
    type: z.literal('excludeUnattributedPosts'),
    postIds: z
      .array(id)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Select each post once.'),
    note: z.string().trim().min(5).max(4000),
  }),
  z.object({
    type: z.literal('excludeHistoricalPosts'),
    postIds: z
      .array(id)
      .min(1)
      .max(100)
      .refine((values) => new Set(values).size === values.length, 'Select each post once.'),
    note: z.string().trim().min(5).max(4000),
  }),
  z.object({
    type: z.literal('reviewPost'),
    postId: id,
    decision: z.enum(['accepted', 'excluded']),
    eligibleViews: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    note: z.string().trim().min(5).max(4000),
    evidence: evidence.optional(),
  }),
  z.object({
    type: z.literal('generateStatement'),
    appId: id,
    creatorId: id,
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  }),
  z.object({
    type: z.literal('approveBonus'),
    statementId: id,
    amountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    note: z.string().max(2000).default(''),
  }),
  z.object({ type: z.literal('finalizeStatement'), statementId: id }),
  z.object({
    type: z.literal('markPaid'),
    statementId: id,
    amountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    paidAt: date,
    reference: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal('importRows'),
    posts: z.array(postInputSchema).max(1000),
    snapshots: z.array(snapshotInputSchema).max(5000),
  }),
  z.object({ type: z.literal('approveAdjustment'), adjustmentId: id, approve: z.boolean() }),
  z.object({
    type: z.literal('payAdjustment'),
    adjustmentId: id,
    reference: z.string().trim().min(1).max(200),
    paidAt: date,
  }),
  z.object({
    type: z.literal('adjustment'),
    statementId: id,
    postId: id,
    eligibleViews: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    note: z.string().trim().min(5).max(4000),
    evidence: evidence.optional(),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
