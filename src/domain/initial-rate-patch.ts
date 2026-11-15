import Decimal from 'decimal.js';
import type { RulePatch, Rules } from './model';

/** Compare settings by meaning, not PostgreSQL JSONB object-key order or display formatting. */
export function initialRatePatch(active: Rules, patch: RulePatch): Rules {
  const proposed = {
    ...active,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  } as Rules;
  const conflicts: string[] = [];
  const compare = (
    field: string,
    current: unknown,
    submitted: unknown,
    equal = current === submitted
  ) => {
    if (!equal)
      conflicts.push(
        `${field} (active: ${JSON.stringify(current)}; submitted: ${JSON.stringify(submitted)})`
      );
  };
  const sameMoney = (a: string, b: string) => new Decimal(a).eq(new Decimal(b));
  compare(
    'cpmMode',
    active.cpmMode,
    proposed.cpmMode,
    active.cpmMode === 'progressive' && proposed.cpmMode === 'progressive'
  );
  compare('windowDays', active.windowDays, proposed.windowDays);
  compare('flatCpm', active.flatCpm, proposed.flatCpm, sameMoney(active.flatCpm, proposed.flatCpm));
  compare(
    'monthlyCap',
    active.monthlyCap,
    proposed.monthlyCap,
    active.monthlyCap === null || proposed.monthlyCap === null
      ? active.monthlyCap === proposed.monthlyCap
      : sameMoney(active.monthlyCap, proposed.monthlyCap)
  );
  compare('bonusApproval', active.bonusApproval, proposed.bonusApproval);
  compare(
    'bonusPlatforms',
    active.bonusPlatforms,
    proposed.bonusPlatforms,
    active.bonusPlatforms.length === proposed.bonusPlatforms.length &&
      active.bonusPlatforms.every((platform) => proposed.bonusPlatforms.includes(platform))
  );
  for (const platform of new Set(
    [...active.fixedPayments, ...proposed.fixedPayments].map((payment) => payment.platform)
  )) {
    const current = active.fixedPayments.find((payment) => payment.platform === platform);
    const submitted = proposed.fixedPayments.find((payment) => payment.platform === platform);
    if (!current || !submitted) {
      compare(`fixedPayments[${platform}]`, current ?? null, submitted ?? null);
    } else {
      compare(
        `fixedPayments[${platform}].amount`,
        current.amount,
        submitted.amount,
        sameMoney(current.amount, submitted.amount)
      );
      compare(
        `fixedPayments[${platform}].minimumViews`,
        current.minimumViews,
        submitted.minimumViews
      );
    }
  }
  compare('tiers.length', active.tiers.length, proposed.tiers.length);
  for (let index = 0; index < Math.min(active.tiers.length, proposed.tiers.length); index++)
    compare(`tiers[${index}].upTo`, active.tiers[index].upTo, proposed.tiers[index].upTo);
  if (conflicts.length)
    throw new Error(
      `Initial activation may change progressive CPM rates only. Conflicting fields: ${conflicts.join('; ')}. Reload the active settings and change only the CPM rate values.`
    );
  if (active.tiers.every((tier, index) => sameMoney(tier.cpm, proposed.tiers[index].cpm)))
    throw new Error(
      'No CPM rate differs from the currently active policy. Refresh the workspace and change a rate before activating.'
    );
  // Retain every active non-rate value verbatim, including array order and decimal strings.
  return {
    ...active,
    tiers: active.tiers.map((tier, index) => ({ ...tier, cpm: proposed.tiers[index].cpm })),
  };
}
