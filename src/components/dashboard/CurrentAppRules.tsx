import type { AppRecord, RuleVersion } from '@/domain/model';
import { resolveRules } from '@/domain/compensation';
import { formatTimestamp } from '@/domain/time';
import { Badge, number } from './Primitives';
/** Resolve at the confirmed workspace timestamp, never from the latest future version. */
export function CurrentAppRules({
  app,
  versions,
  asOf,
}: {
  app: AppRecord;
  versions: RuleVersion[];
  asOf: string;
}) {
  const r = resolveRules(versions, app.id, '', '', asOf).rules;
  return (
    <section className="card rule-card">
      <div className="section-heading">
        <h2>{app.name} defaults · Active now</h2>
        <Badge tone="purple">{r.windowDays}-day window</Badge>
      </div>
      <p className="subtle">Active as of {formatTimestamp(asOf)}</p>
      <h3>Fixed payments</h3>
      {r.fixedPayments.map((p) => (
        <p key={p.platform} className="rule-line">
          <span className="capitalize">{p.platform}</span>
          <b>
            ${p.amount} <small>at {number(p.minimumViews)} views</small>
          </b>
        </p>
      ))}
      <h3>Performance bonus</h3>
      {r.cpmMode === 'progressive' ? (
        r.tiers.map((t, i) => (
          <p className="rule-line" key={i}>
            <span>
              {i === 0 ? 'First' : `Above ${number(r.tiers[i - 1].upTo || 0)}`}{' '}
              {t.upTo === null ? ' · unlimited' : number(t.upTo)}
            </span>
            <b>${t.cpm} CPM</b>
          </p>
        ))
      ) : (
        <p>{r.cpmMode === 'flat' ? `$${r.flatCpm} CPM` : 'Disabled'}</p>
      )}
      <div className="rule-footer">
        <span>
          Monthly cap <b>{r.monthlyCap ? `$${r.monthlyCap}` : 'Uncapped'}</b>
        </span>
        <Badge tone="amber">
          {r.bonusApproval ? 'Bonus approval required' : 'Bonus automatic'}
        </Badge>
      </div>
    </section>
  );
}
