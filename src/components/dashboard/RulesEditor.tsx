'use client';
import { Input, Select, Switch } from '@/components/ui/controls';
import { AsyncButton } from './AsyncButton';
import { instant, instantSchema } from '@/domain/time';
import { useState } from 'react';
import { Plus, Trash2, GitBranch } from 'lucide-react';
import type { DashboardData, RulePatch, RuleVersion, Rules } from '@/domain/model';
import { platforms, verselRules } from '@/domain/model';
import { nextMonthStart, resolveRules } from '@/domain/compensation';
import { initialSetupStatus } from '@/domain/initial-setup-rules';
import { activeEditorPatch } from '@/domain/rule-editor';
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
  const asOf = data.readModel?.generatedAt ?? new Date().toISOString();
  const [patch, setPatch] = useState<RulePatch>(() =>
    activeEditorPatch(data, 'app', defaultAppId, '', '', asOf)
  );
  const [effective, setEffective] = useState(nextMonthStart());
  const [activation, setActivation] = useState<'scheduled' | 'initial_setup_now'>('scheduled');
  const [confirmed, setConfirmed] = useState(false);
  const setup = data.readModel
    ? (data.readModel.initialSetup?.[appId] ?? {
        allowed: false,
        postCount: 0,
        draftCount: 0,
        reason: 'Refresh the workspace to check initial-setup eligibility.',
      })
    : initialSetupStatus(data, appId, new Date().toISOString());
  const activateNow = scope === 'app' && activation === 'initial_setup_now';
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
    setPatch(activeEditorPatch(data, s, a, c, u, asOf));
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
      <Switch
        disabled={activateNow}
        checked={override(key)}
        onCheckedChange={() => toggle(key)}
        label={label}
      />
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
        if (activateNow && (!setup.allowed || !confirmed)) {
          setError('Confirm initial setup before activating.');
          return;
        }
        setError('');
        setBusy(true);
        try {
          await onSave({
            type: 'saveRules',
            activation: activateNow ? 'initial_setup_now' : 'scheduled',
            scope,
            appId,
            campaignId: scope.includes('campaign') ? campaignId : null,
            creatorId: scope.startsWith('creator') ? creatorId : null,
            effectiveAt: activateNow ? new Date().toISOString() : instant(effective),
            patch: activateNow ? { tiers: patch.tiers ?? values.tiers } : patch,
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
          publication-time rules. Monthly changes normally start next month; the guarded
          initial-setup option below is for unearned company/test content only.
        </p>
      </div>
      <label className="field">
        <span>App</span>
        <Select
          value={appId}
          onChange={(e) => {
            setAppId(e.target.value);
            setActivation('scheduled');
            setConfirmed(false);
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
            setActivation('scheduled');
            setConfirmed(false);
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
      {scope === 'app' && (
        <>
          <label className="field">
            <span>Activation</span>
            <Select
              value={activation}
              onChange={(event) => {
                const next = event.target.value as typeof activation;
                setActivation(next);
                setConfirmed(false);
                if (next === 'initial_setup_now') load('app', appId, '', '');
              }}
            >
              <option value="scheduled">Scheduled rule version</option>
              <option value="initial_setup_now" disabled={!setup.allowed}>
                Activate now · initial setup only
              </option>
            </Select>
            <small>{setup.reason}</small>
          </label>
          {activateNow && (
            <div className="info-box">
              <div>
                <strong>Initial setup: progressive CPM rates only</strong>
                <p>
                  Uses the currently active settings, not a future scheduled version. Selecting this
                  mode reloads the active rates; edit the CPM rates after selecting it. Activates at
                  server receipt time. Aligns {setup.postCount} current-month company/test posts and{' '}
                  {setup.draftCount} zero-value drafts. Fixed payments, thresholds, windows,
                  observations, past months and rule history stay intact. Scheduled future versions
                  remain scheduled.
                </p>
                <label className="inline-check">
                  <Input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  No real creator has earned compensation. I approve aligning this month’s unearned
                  company/test records with these CPM rates.
                </label>
              </div>
            </div>
          )}
        </>
      )}
      <label className="field">
        <span>Effective from</span>
        <Input
          type="text"
          value={activateNow ? 'Immediately · authoritative server time' : effective}
          disabled={activateNow}
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
          disabled={activateNow || !override('windowDays')}
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
            disabled={activateNow || !override('windowDays')}
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
                  disabled={activateNow || !override('fixedPayments')}
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
                      disabled={activateNow || !override('fixedPayments')}
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
                      disabled={activateNow || !override('fixedPayments')}
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
          disabled={activateNow || !override('cpmMode')}
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
              disabled={activateNow || !override('flatCpm')}
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
                  disabled={activateNow || !override('tiers') || t.upTo === null}
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
                    disabled={activateNow || !override('tiers')}
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
              disabled={activateNow || !override('tiers')}
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
                disabled={activateNow || !override('bonusPlatforms')}
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
            disabled={activateNow || !override('monthlyCap')}
            value={values.monthlyCap ?? ''}
            placeholder="No cap"
            onChange={(e) => set('monthlyCap', e.target.value || null)}
          />
        </section>
      )}
      <section className="rule-section">
        {control('bonusApproval', 'Bonus approval policy')}
        <Select
          disabled={activateNow || !override('bonusApproval')}
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
      <AsyncButton
        className="button primary"
        disabled={busy || (activateNow && (!confirmed || !setup.allowed))}
        busy={busy}
      >
        {activateNow ? 'Activate initial CPM rates now' : 'Save new rule version'}
      </AsyncButton>
    </form>
  );
}
