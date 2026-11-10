import type { AuditEvent, DashboardData, RulePatch } from './model';
export const ruleScopeLabels: Record<string, string> = {
  app: 'App defaults',
  campaign: 'Campaign override',
  creator_app: 'Creator · app override',
  creator_campaign: 'Creator · campaign override',
};
const usd = (value: string) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6,
  }).format(Number(value));
export function ruleDescription(patch: RulePatch): string {
  const parts: string[] = [];
  if (patch.windowDays !== undefined)
    parts.push(`${patch.windowDays * 24}-hour eligibility window`);
  if (patch.fixedPayments !== undefined)
    parts.push(
      patch.fixedPayments.length
        ? `Fixed payments: ${patch.fixedPayments.map((p) => `${usd(p.amount)} per ${p.platform} video at ${p.minimumViews.toLocaleString('en-US')} eligible views`).join('; ')}`
        : 'No fixed payments'
    );
  if (patch.cpmMode !== undefined)
    parts.push(`Bonus mode: ${patch.cpmMode === 'disabled' ? 'disabled' : patch.cpmMode}`);
  if (patch.tiers !== undefined)
    parts.push(
      `Progressive CPM: ${patch.tiers.map((t) => `${usd(t.cpm)} ${t.upTo === null ? 'above the previous tier' : `up to ${t.upTo.toLocaleString('en-US')} views`}`).join('; ')}`
    );
  if (patch.flatCpm !== undefined) parts.push(`Flat CPM: ${usd(patch.flatCpm)}`);
  if (patch.bonusPlatforms !== undefined)
    parts.push(`Bonus platforms: ${patch.bonusPlatforms.join(', ') || 'none'}`);
  if (patch.monthlyCap !== undefined)
    parts.push(
      patch.monthlyCap === null ? 'No monthly cap' : `Monthly cap: ${usd(patch.monthlyCap)}`
    );
  if (patch.bonusApproval !== undefined)
    parts.push(
      patch.bonusApproval ? 'Manual bonus approval required' : 'No separate bonus approval required'
    );
  return parts.join(' · ') || 'Inherit existing defaults';
}
export function auditDescription(event: AuditEvent, data: DashboardData): string {
  const labels: Record<string, string> = {
    connect: 'Social account connected',
    disconnect: 'Social account disconnected',
    archive: 'Record archived',
    restore: 'Record restored',
    remove: 'Unused record removed',
    createApp: 'App added',
    createCampaign: 'Campaign created',
    createCreator: 'Creator registered',
    updateEntity: 'Details updated',
    assignCreator: 'Creator assigned to a campaign',
    registerAccount: 'Social account registered',
    mapAccount: 'Account campaign routing updated',
    saveRules: 'Compensation rules updated',
    addPost: 'Post registered',
    addSnapshot: 'View observation recorded',
    attributePost: 'Post campaign assigned',
    reviewPost: 'Post eligibility reviewed',
    excludeHistoricalPosts: 'Historical posts excluded from compensation',
    importRows: 'Data imported',
    generateStatement: 'Monthly payout calculated',
    approveBonus: 'Performance bonus reviewed',
    finalizeStatement: 'Payout statement finalized',
    markPaid: 'Payment recorded',
    adjustment: 'Payout correction proposed',
    approveAdjustment: 'Payout correction reviewed',
    payAdjustment: 'Correction payment recorded',
  };
  const entity =
    data.creators.find((c) => c.id === event.entity_id)?.name ||
    data.apps.find((a) => a.id === event.entity_id)?.name ||
    data.campaigns.find((c) => c.id === event.entity_id)?.name;
  return `${labels[event.action] || 'Workspace record updated'}${entity ? ` · ${entity}` : ''}`;
}
