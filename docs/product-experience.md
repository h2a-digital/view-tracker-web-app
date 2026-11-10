# Product experience and Analytics

This update changes the dashboard and one profile URL validation rule. It does not change OAuth, provider jobs, campaign attribution, compensation calculations, approved statements, retention, or deletion protections. The paused official TikTok adapter is not restored or changed.

**Follow-up:** button idle spacing, compact confirmations, post grids and thumbnail retention are documented in [Post previews](post-previews.md). That update introduces one incremental thumbnail-cache retention migration.

## Component system

The existing Next.js 16 / React 19 / Tailwind 4 stack remains. Components in `src/components/ui/controls.tsx` use the [shadcn Radix composition approach](https://ui.shadcn.com/docs/components/radix/select), with owned styles matching the dashboard. This is not a second styled framework or a frontend rewrite.

- Radix Select replaces native dashboard selects; entity lists of more than seven options use Radix Popover + cmdk search. Menus and options use collision-aware portals, keyboard navigation, focus management, and bounded scrolling.
- Radix Dropdown Menu replaces the custom HTML record menus and creator action drawer, avoiding table clipping.
- Shared native Input/Textarea components preserve form data and browser validation. The form boundary additionally checks required values, and server Zod validation remains authoritative. Names/notes retain their existing maximum lengths.
- Radix Checkbox/Switch standardize toggles. Existing Radix Dialog powers both detail Sheets and compact confirmations. Tooltip uses Radix. The existing promise-aware Button is reused, including duplicate guards, errors, and icon replacement while loading.
- The neutral charcoal / subdued blue styles apply across navigation, cards, tables, forms and drawers. Existing platform colors remain restrained. Technical identifiers and full metric diagnostics are collapsible; important uncertainty and deletion warnings remain visible.

No React Hook Form, chart package, or alternate UI framework is introduced. Component styles live with the existing global CSS to avoid conflicting Tailwind/theme systems.

## Creator editing

Creators → row or actions menu → **Edit creator** edits only existing name, email and notes. Existing `updateEntity` validation and admin-only dashboard API persist changes. Provider identities, accounts, campaign relationships, historical posts and compensation remain unchanged. Record removal/archival still uses existing guarded server operations.

## TikTok avatar diagnosis

A read-only `GET /v1/accounts` against the existing Zernio workspace returned a TikTok `profilePicture` on `p16-common-sign.tiktokcdn-eu.com`, with a future image expiry. A read-only image GET returned HTTP 200 / image/jpeg (the CDN does not support HEAD).

Our existing sanitizer rejected the signed CDN URL solely because it contained a `refresh_token` query parameter. It now permits that parameter only on the existing TikTok CDN domain allowlist. HTTPS, host-boundary validation, and the rejection of OAuth access-token/client-secret parameters remain. Credential-bearing URLs on other hosts remain rejected. No signed URLs, tokens, account payloads or keys are logged in this document.

Existing scheduled profile refreshes will persist the newly accepted avatar without reconnection. For immediate validation use that account's Details → Refresh profile details. The browser image still has no referrer and falls back on failure. The provider controls image validity; a cached image can expire before its next refresh. No scraping or new permissions are involved.

## Analytics definitions and limitations

- Filters: global app switcher, campaign, creator, platform, and publication date range in America/New_York. End date also limits included public observations and acceptance dates. An empty end date means today in New York. Financial records are current finalized ledger records, not an as-of financial reconstruction.
- One publication per `(platform, platform_post_id)`; conflicting attribution is omitted and reported rather than arbitrarily choosing an app/campaign. The system cannot identify different platform IDs as the same creative. Cross-posts on different platforms are separate platform publications.
- **Public views:** one latest `public_views` cumulative reading per video, available by the selected end date. Daily, paid, organic-only and supporting counters are not mislabelled as public totals. Public totals can extend beyond the seven-day window and are not organic proof. Missing counters remain missing, not measured zeroes. Policy-blocked views and erased/deleted source records are excluded.
- **Verified eligible views:** accepted totals with organic and cutoff evidence, not provisional tracking counts; approval must have occurred by the selected end date. Historic approvals without this evidence are not represented as verified in Analytics. This reporting rule changes no existing compensation calculation.
- **Observed public views over time:** latest reported reading per selected video at each observation date. Cached readings carry forward. It is not daily gained views or a reconstruction of missing observations. Accessible chart data includes the number of covered posts; account discovery, delayed metrics, deletions and counter corrections can change the curve. No inference is made for missing history.
- Creator/platform tables show publication counts, observed public views, verified eligible views, and average public views per post **with an observation**. Counts expose observation coverage. Header buttons and the sort selector sort the performance breakdowns.
- **Compensation:** finalized/paid app+creator statements for complete publication months wholly inside the date range, including approved/paid corrections. Campaign/platform filters hide financial totals because shared caps and bonus tiers cannot safely be prorated.
- **Effective CPM:** finalized eligible payout in USD ÷ the statement's frozen eligible line views × 1,000. Includes fixed payments and is not the bonus tier rate. Corrections, missing/redacted evidence, or policy-blocked accounts make the denominator unavailable; money is retained and CPM is not invented. Draft estimates stay in Monthly payouts.
- No downloads, conversion, revenue or fraud-attribution claims are introduced. Old unobserved views and exact seven-day organic totals cannot be reconstructed from lifetime counts.

## Deployment prerequisites

No **new** SQL migration, environment variable, OAuth permission, or Cron change is required for this update. Previously prepared profile/management migrations are separate prerequisites for their existing functionality: `202611090001_dashboard_management.sql` and `202611090003_social_profiles.sql`. The user has confirmed the YouTube metadata migration `202611090002_youtube_channel_metadata.sql` is applied. Verify the other two independently before deployment; do not rerun applied migrations. No migration is executed during this development work.

Profile refresh cadence remains approximately 24 hours after success, with one-hour retries after failure and one profile per available existing worker execution. Temporary provider failure retains cached values. Manual per-account refresh retains its cooldown. This update adds no polling.

## Local visual / interaction checklist

Use `npm run dev`, then `http://localhost:3000/?preview=1` for isolated sample data. Preview changes are in memory; preview deletion/archival stays disabled. Avoid destructive live-connected actions just to test styling.

1. At 1440px / 1024px / 390px, navigate every dashboard section; verify compact controls, readable tables, horizontal table scrolling, and Social Accounts' maximum 3 / 2 / 1 columns with equal-height cards and aligned footers.
2. Tab through controls. Open selectors using keyboard; type to search a list of >7 items; choose with arrows/Enter; Escape closes and restores focus. Check long names, no matches, menus near viewport edges, and nested controls inside a Sheet.
3. Open a creator's actions menu inside its table. Choose Edit creator; change name/email/notes, test invalid email and blank name, then save. Verify loading/error feedback and unchanged accounts/mappings/posts/payouts.
4. Open account and post Details. Technical details should start collapsed, important warnings stay visible, action groups wrap, and destructive confirmations are compact. Close with Escape; verify focus returns to the trigger. Do not confirm destructive actions against production data.
5. Refresh workspace and queue Sync only when intentionally testing the existing worker. One spinner should replace the action icon without shifting layout; duplicate clicks should be disabled; content should remain visible. Test a network failure and recovery.
6. TikTok Details → Refresh profile details: check cached avatar renders. Simulate a failed image request with browser DevTools to check fallback. No reconnection is needed.
7. Analytics: test empty and populated scopes, all filters, sortable tables, chart coverage and accessible chart data. Confirm cumulative readings aren't summed, public and verified views stay distinct, and campaign/platform/partial-month filters do not invent financial allocations.
8. Enable reduced motion and check focus visibility, color contrast and touch targets. A live browser session was unavailable to the development agent, so interactive visual QA remains required before deployment.
