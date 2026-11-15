import type { DashboardData, RulePatch, RuleVersion } from './model';
import { resolveRules } from './compensation';
/** Form baselines must come from the active version, never the last scheduled version. */
export function activeEditorPatch(
  data: DashboardData,
  scope: RuleVersion['scope'],
  appId: string,
  campaignId: string,
  creatorId: string,
  asOf: string
): RulePatch {
  if (scope === 'app')
    return structuredClone(resolveRules(data.ruleVersions, appId, '', '', asOf).rules);
  const version = data.ruleVersions
    .filter(
      (version) =>
        version.scope === scope &&
        version.app_id === appId &&
        version.campaign_id === (scope.includes('campaign') ? campaignId : null) &&
        version.creator_id === (scope.startsWith('creator') ? creatorId : null) &&
        version.effective_at <= asOf
    )
    .sort(
      (a, b) =>
        a.effective_at.localeCompare(b.effective_at) ||
        a.created_at.localeCompare(b.created_at) ||
        a.id.localeCompare(b.id)
    )
    .at(-1);
  return structuredClone(version?.patch ?? {});
}
