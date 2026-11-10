'use client';
import { Input, Select, Switch } from '@/components/ui/controls';
import { AsyncButton } from './AsyncButton';
import { instant, instantSchema } from '@/domain/time';
import { useState } from 'react';
import { Plus, Trash2, GitBranch } from 'lucide-react';
import type { DashboardData, RulePatch, RuleVersion, Rules } from '@/domain/model';
import { platforms, verselRules } from '@/domain/model';
import { nextMonthStart, resolveRules } from '@/domain/compensation';
import type { Command } from '@/domain/validation';

export function RulesEditor({
  data,
  defaultAppId,
  onSave,
}: {
  data: DashboardData;
  defaultAppId: string;
  onSave: (command: Command) => Promise<void>;
}) {
  const [appId, setAppId] = useState(defaultAppId);
  const [scope, setScope] = useState<RuleVersion['scope']>('app');
  const [campaignId, setCampaignId] = useState(
    data.campaigns.find((c) => c.app_id === defaultAppId)?.id || ''
  );
  const [creatorId, setCreatorId] = useState(data.creators[0]?.id || '');
  const [patch, setPatch] = useState<RulePatch>(
    () =>
      data.ruleVersions
        .filter((v) => v.scope === 'app' && v.app_id === defaultAppId)
        .sort((a, b) => a.effective_at.localeCompare(b.effective_at))
        .at(-1)?.patch ?? {}
  );
  const [effective, setEffective] = useState(nextMonthStart());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const campaigns = data.campaigns.filter((c) => c.app_id === appId);
  const levels = ['app', 'campaign', 'creator_app', 'creator_campaign'];
  const inherited = resolveRules(
    data.ruleVersions.filter((v) => levels.indexOf(v.scope) < levels.indexOf(scope)),
    appId,
    campaignId,
    creatorId,
    instantSchema.safeParse(effective).success ? instant(effective) : new Date().toISOString()
  ).rules;
  const values: Rules = { ...verselRules, ...inherited, ...patch };
  const load = (s: RuleVersion['scope'], a: string, c: string, u: string) => {
    const v = data.ruleVersions
      .filter(
        (v) =>
          v.scope === s &&
          v.app_id === a &&
          v.campaign_id === (s.includes('campaign') ? c : null) &&
          v.creator_id === (s.startsWith('creator') ? u : null)
      )
      .sort((a, b) => a.effective_at.localeCompare(b.effective_at))
      .at(-1);
    setPatch(v?.patch ?? {});
  };
  const override = (key: keyof Rules) => Object.hasOwn(patch, key);
  const set = <K extends keyof Rules>(key: K, value: Rules[K]) =>
    setPatch((p) => ({ ...p, [key]: value }));
  function toggle(key: keyof Rules) {
    if (override(key)) {
      setPatch((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    } else setPatch((p) => ({ ...p, [key]: values[key] }));
  }
  const control = (key: keyof Rules, label: string) => (
    <label className="override-switch">
      <Switch checked={override(key)} onCheckedChange={() => toggle(key)} label={label} />
      <span>{label}</span>
      <small>{override(key) ? 'Override' : 'Inherited'}</small>
    </label>
  );
  return (
    <form
      className="panel-form rules-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setError('');
        setBusy(true);
        try {
          await onSave({
            type: 'saveRules',
            scope,
            appId,
            campaignId: scope.includes('campaign') ? campaignId : null,
            creatorId: scope.startsWith('creator') ? creatorId : null,
            effectiveAt: instant(effective),
            patch,
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Could not save rules.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="info-box">
        <GitBranch size={18} />
        <p>
          App defaults → campaign → creator/app → creator/campaign. Posts keep their
          publication-time rules. Monthly changes start next month.
        </p>
      </div>
      <label className="field">
        <span>App</span>
        <Select
          value={appId}
          onChange={(e) => {
            setAppId(e.target.value);
            const c = data.campaigns.find((c) => c.app_id === e.target.value)?.id || '';
            setCampaignId(c);
            load(scope, e.target.value, c, creatorId);
          }}
        >
          {data.apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="field">
        <span>Rule level</span>
        <Select
          value={scope}
          onChange={(e) => {
            const s = e.target.value as RuleVersion['scope'];
            setScope(s);
            load(s, appId, campaignId, creatorId);
          }}
        >
          <option value="app">App defaults</option>
          <option value="campaign">Campaign override</option>
          <option value="creator_app">Creator · this app</option>
          <option value="creator_campaign">Creator · this campaign</option>
        </Select>
      </label>
      {scope.includes('campaign') && (
        <label className="field">
          <span>Campaign</span>
          <Select
            value={campaignId}
            required
            onChange={(e) => {
              setCampaignId(e.target.value);
              load(scope, appId, e.target.value, creatorId);
            }}
          >
            <option value="">Select campaign</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {scope.startsWith('creator') && (
        <label className="field">
          <span>Creator</span>
          <Select
            value={creatorId}
            required
            onChange={(e) => {
              setCreatorId(e.target.value);
              load(scope, appId, campaignId, e.target.value);
            }}
          >
            <option value="">Select creator</option>
            {data.creators.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      <label className="field">
        <span>Effective from</span>
        <Input
          type="text"
          value={effective}
          required
          onChange={(e) => setEffective(e.target.value)}
        />
        <small>
          Enter ISO 8601 with Z or an explicit offset. Monthly policies start at New York midnight
          on the first day of a future month.
        </small>
      </label>
      <section className="rule-section">
        {control('windowDays', 'Tracking window')}
        <Select
          disabled={!override('windowDays')}
          value={[7, 14, 30].includes(values.windowDays) ? values.windowDays : 'custom'}
          onChange={(e) =>
            set('windowDays', e.target.value === 'custom' ? 10 : Number(e.target.value))
          }
        >
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
          <option value="custom">Custom</option>
        </Select>
        {![7, 14, 30].includes(values.windowDays) && (
          <Input
            aria-label="Custom window days"
            type="number"
            min="0.01"
            max="365"
            step="any"
            disabled={!override('windowDays')}
            value={values.windowDays}
            onChange={(e) => set('windowDays', Number(e.target.value))}
          />
        )}
      </section>
      <section className="rule-section">
        {control('fixedPayments', 'Fixed payments')}
        <p className="muted small">One payment per qualifying platform post.</p>
        {platforms.map((platform) => {
          const payment = values.fixedPayments.find((p) => p.platform === platform);
          return (
            <div className="fixed-rule" key={platform}>
              <label>
                <Input
                  type="checkbox"
                  disabled={!override('fixedPayments')}
                  checked={!!payment}
                  onChange={(e) =>
                    set(
                      'fixedPayments',
                      e.target.checked
                        ? [...values.fixedPayments, { platform, amount: '10', minimumViews: 1000 }]
                        : values.fixedPayments.filter((p) => p.platform !== platform)
                    )
                  }
                />
                {platform}
              </label>
              {payment && (
                <div className="two-col">
                  <label className="field">
                    <span>USD / post</span>
                    <Input
                      disabled={!override('fixedPayments')}
                      type="number"
                      min="0"
                      step="0.01"
                      value={payment.amount}
                      onChange={(e) =>
                        set(
                          'fixedPayments',
                          values.fixedPayments.map((p) =>
                            p.platform === platform ? { ...p, amount: e.target.value } : p
                          )
                        )
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Minimum views</span>
                    <Input
                      disabled={!override('fixedPayments')}
                      type="number"
                      min="0"
                      step="1"
                      value={payment.minimumViews}
                      onChange={(e) =>
                        set(
                          'fixedPayments',
                          values.fixedPayments.map((p) =>
                            p.platform === platform
                              ? { ...p, minimumViews: Number(e.target.value) }
                              : p
                          )
                        )
                      }
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </section>
      <section className="rule-section">
        {control('cpmMode', 'CPM bonus model')}
        <Select
          disabled={!override('cpmMode')}
          value={values.cpmMode}
          onChange={(e) => set('cpmMode', e.target.value as Rules['cpmMode'])}
        >
          <option value="progressive">Progressive tiers</option>
          <option value="flat">Flat CPM</option>
          <option value="disabled">No performance bonus</option>
        </Select>
        {values.cpmMode === 'flat' && (
          <>
            {control('flatCpm', 'Flat rate per 1,000 views')}
            <Input
              aria-label="Flat CPM"
              type="number"
              min="0"
              step="0.01"
              disabled={!override('flatCpm')}
              value={values.flatCpm}
              onChange={(e) => set('flatCpm', e.target.value)}
            />
          </>
        )}
        {values.cpmMode === 'progressive' && (
          <>
            {control('tiers', 'Progressive rates')}
            <div className="tier-labels">
              <span>Up to cumulative views</span>
              <span>USD / 1,000</span>
            </div>
            {values.tiers.map((t, i) => (
              <div className="tier-row" key={i}>
                <Input
                  aria-label={`Tier ${i + 1} upper threshold`}
                  disabled={!override('tiers') || t.upTo === null}
                  type={t.upTo === null ? 'text' : 'number'}
                  min="1"
                  value={t.upTo ?? 'Unlimited'}
                  onChange={(e) =>
                    set(
                      'tiers',
                      values.tiers.map((x, n) =>
                        n === i ? { ...x, upTo: Number(e.target.value) } : x
                      )
                    )
                  }
                />
                <Input
                  aria-label={`Tier ${i + 1} rate`}
                  disabled={!override('tiers')}
                  type="number"
                  min="0"
                  step="0.01"
                  value={t.cpm}
                  onChange={(e) =>
                    set(
                      'tiers',
                      values.tiers.map((x, n) => (n === i ? { ...x, cpm: e.target.value } : x))
                    )
                  }
                />
                {t.upTo !== null && (
                  <AsyncButton
                    type="button"
                    className="icon-button"
                    aria-label="Remove tier"
                    disabled={!override('tiers')}
                    onClick={() =>
                      set(
                        'tiers',
                        values.tiers.filter((_, n) => n !== i)
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </AsyncButton>
                )}
              </div>
            ))}
            <AsyncButton
              type="button"
              className="button subtle"
              disabled={!override('tiers')}
              onClick={() => {
                const tiers = [...values.tiers];
                tiers.splice(tiers.length - 1, 0, {
                  upTo: (tiers.at(-2)?.upTo ?? 0) + 100000,
                  cpm: '0.25',
                });
                set('tiers', tiers);
              }}
            >
              <Plus size={14} /> Add tier
            </AsyncButton>
          </>
        )}
      </section>
      <section className="rule-section">
        {control('bonusPlatforms', 'Platforms included in CPM')}
        <div className="check-list">
          {platforms.map((p) => (
            <label key={p}>
              <Input
                type="checkbox"
                disabled={!override('bonusPlatforms')}
                checked={values.bonusPlatforms.includes(p)}
                onChange={(e) =>
                  set(
                    'bonusPlatforms',
                    e.target.checked
                      ? [...values.bonusPlatforms, p]
                      : values.bonusPlatforms.filter((x) => x !== p)
                  )
                }
              />
              {p}
            </label>
          ))}
        </div>
      </section>
      {!scope.includes('campaign') && (
        <section className="rule-section">
          {control('monthlyCap', 'Monthly cap per app / creator')}
          <Input
            aria-label="Monthly cap in USD"
            type="number"
            min="0"
            step="0.01"
            disabled={!override('monthlyCap')}
            value={values.monthlyCap ?? ''}
            placeholder="No cap"
            onChange={(e) => set('monthlyCap', e.target.value || null)}
          />
        </section>
      )}
      <section className="rule-section">
        {control('bonusApproval', 'Bonus approval policy')}
        <Select
          disabled={!override('bonusApproval')}
          value={String(values.bonusApproval)}
          onChange={(e) => set('bonusApproval', e.target.value === 'true')}
        >
          <option value="true">Manual approval required</option>
          <option value="false">Automatic bonus</option>
        </Select>
      </section>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <AsyncButton className="button primary" disabled={busy} busy={busy}>
        Save new rule version
      </AsyncButton>
    </form>
  );
}
