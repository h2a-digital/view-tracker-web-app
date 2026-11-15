# Immediate CPM activation during initial setup

## Investigation

A read-only production inspection on November 13, 2026 confirmed the existing Versel app-default version has $1.50 / $0.50 / $0.25 progressive CPM, and a retained version scheduled for December 1 has $1.00 / $0.50 / $0.25. All six attributed records are company-owned test content with unset eligible totals and no eligibility evidence. September, October and November statements are draft, zero-value, unapproved and have no payment lines. There are no adjustments. No production records were modified during this investigation.

App defaults alone cannot safely be switched while leaving the current month's frozen test-post policy and draft policy inconsistent: the normal one-policy-per-creator/app/month checks would reject later posts. The explicit setup action therefore creates a new version effective at server receipt time and aligns only current-month, unearned company/test post CPM rates and zero-value draft CPM policies. The accounting month is America/New_York. This is the sole, explicit setup exception to publication-time CPM freezing; it does not change fixed payments, windows, snapshots, publication dates, campaign assignments, prior months, approved amounts or finalized history. Existing rule-version IDs are retained and the activation version ID is appended to affected test posts for provenance. An audit event records the action.

## November 15 validation correction

A read-only production comparison confirmed that all non-rate values in the active January version and scheduled December version match. Only `tiers[0].cpm` differs ($1.50 vs $1.00). The reproduced rejection was caused by JSON property order: PostgreSQL JSONB returns a fixed-payment object with keys `amount, platform, minimumViews`, while the request schema reconstructs it as `platform, amount, minimumViews`. The old whole-object `JSON.stringify` check rejected these identical values. Dates were not included in that comparison; the seven-day window, cap/null values, platform selections, fixed amount/threshold, approvals and unused flat CPM were not materially different. This diagnosis used the stored production policies and the form/request parsing path; the failed browser request body was not captured or logged.

Validation now compares individual settings by meaning, tolerating only harmless currency formatting, object-key ordering and selection ordering. It preserves every active non-rate representation when saving. True changes produce a list of exact conflicting paths with active/submitted values (for example `fixedPayments[tiktok].amount` or `tiers[0].upTo`). Financial eligibility, account ownership, ledger and revision guards are unchanged.

The form now initializes from active settings rather than the latest future version. Entering initial activation explicitly reloads active app settings; edit the CPM rates **after** selecting this mode. Its request includes only tier edits, while the server independently verifies all explicitly supplied settings against the authoritative active policy. Existing future versions remain intact. Another application deployment is required; there is no additional migration or environment change.

## Guards

The server checks the complete authoritative workspace on every save, rather than trusting browser summaries or the administrator's checkbox:

- App defaults only, with an active app and no campaign/creator rule overrides.
- No accepted eligibility (including accepted zero), positive eligible totals, review evidence, erased source history or other unresolved approval markers.
- All attributed accounts must be company-owned; creator-owned/unknown accounts block the exception.
- No positive organic-view evidence for attributed posts. Public/uncertain observations are retained and are not treated as earned organic compensation.
- Every app statement must be an unapproved, zero-value draft with no lines, payment/finalization metadata or redaction. Even approving a zero bonus prevents setup activation.
- No adjustments attached to the app's statements.
- Current-month test post and draft monthly policies must match the active app policy before activation.
- Progressive rate values only. Tier thresholds, CPM mode, fixed payments, thresholds, tracking window, cap, enabled platforms and approval rules cannot change through this option.

Any failed condition rejects the entire command without changes. Ordinary scheduled changes still prohibit backdating and require monthly policy changes at the first of a future New York month. A scheduled future patch no longer evades this guard merely by matching the latest future version: comparison uses the policy currently active at that scope. Existing database revision fencing rejects a save if synchronization or another administrator action changed the workspace after it was read.

This setup option is not available for established paid/approved/earned ledgers. Once real creator-owned posts or compensation evidence exist, use normal future-month versioning. Initial setup is never automatically selected or executed.

## Manual production activation

Implementation and tests do not activate any rate in production. After reviewing this change:

1. Deploy this code to the existing Netlify production site using your normal approved deployment procedure. There is **no SQL migration, seed, new environment variable or provider configuration** for this feature.
2. Sign in as the authorized administrator at `https://creatorhub.h2adigital.com`. Refresh the workspace to load complete, current setup eligibility.
3. Open **Compensation → Configure rules**. Select **Versel → App defaults**.
4. Choose **Activation → Activate now · initial setup only** first. This reloads the actually active app settings ($1.50 first-tier CPM until activation), rather than December’s scheduled values.
5. Change only the first progressive CPM rate to **1.00**; keep the next rates **0.50**, **0.25** and thresholds **100,000**, **500,000**, **Unlimited**. Verify the unchanged settings: TikTok-only **$10 at 1,000 eligible views**, **7 days**, **$3,000 monthly cap**, manual bonus approval, and the same enabled bonus platforms. Facebook remains excluded.
6. Read the affected current-month test-post/draft counts and confirm the explicit setup checkbox. Non-rate controls are locked in this mode. No date entry is needed; the server assigns the actual activation timestamp.
7. Click **Activate initial CPM rates now** and wait for server-confirmed success. A concurrent worker save can cause a revision conflict: refresh and reopen the form, recheck eligibility/counts and retry. Do not bypass a failed financial guard with SQL.
8. Verify **Versel defaults · Active now** shows **$1.00 / $0.50 / $0.25**. The card resolves rules at the confirmed workspace timestamp and displays “Active as of”; it does not display an upcoming version as already active. Recheck $10 TikTok-only, seven-day tracking, $3,000 cap and bonus approval.
9. Expand **Rule version history**. Confirm the old version and December 1 version remain, plus the new immediate version. The already scheduled December version has the same rates, so it can remain scheduled. Any other future version still takes effect on its own effective date; no future schedule is silently deleted.
10. Confirm the November draft remains $0 with no approved bonus/payment, the test Reel's publication/deadline and observations are unchanged, and prior-month statements retain their original policies. Future creator posts inherit the new active rates, subject to normal eligibility and payout approvals.

If activation is disabled/rejected, read its reason. Do not clear earned/approved records or delete financial history to force eligibility. Use normal versioning or investigate the specific blocker.

## Validation

Regression tests cover zero-value draft alignment, immutable historical versions/months, preserved windows/observations, subsequent same-month discovery, creator/financial/source guard failures, protected paid/adjustment ledgers, rejection of non-rate changes, normal scheduling/backdating, active-vs-future display, the limited browser projection, and persistence through the existing schema-v5 PostgreSQL RPC including stale-revision rejection. Tests use simulated data and isolated PGlite only, never production writes.

Under the activated rates, 100K combined eligible views produce a $100 potential CPM bonus, 500K produce $300, 600K produce $325, and 1M produce $425, before fixed payments/cap. Public counters still do not become verified organic views automatically; discretionary bonuses and final payouts retain their existing approvals.
