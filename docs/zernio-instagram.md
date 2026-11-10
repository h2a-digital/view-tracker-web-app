# Instagram through Zernio: minimal pilot

Prepared November 9, 2026. No deployment, live database mutation, account connection/disconnection, or subscription purchase is performed by this implementation. Official TikTok work remains stashed; existing Meta, YouTube and TikTok/Zernio connections are unchanged.

## Prerequisites and verified status

A read-only `GET https://zernio.com/api/v1/accounts` using the locally configured key returned **1 connected account (TikTok), leaving 1 free slot** at the time of inspection. Recheck in Zernio before connecting: other tools can consume that slot. Two accounts cover one TikTok plus one Instagram, across the entire team. Existing free-tier checks (including pending connection reservations) remain enforced. No paid upgrade is attempted.

Zernio documents:

- A Professional **Creator or Business** Instagram account. Personal accounts are unsupported.
- `GET /v1/connect/instagram?profileId=...&loginMethod=instagram_login` for direct Instagram authorization, without a linked Facebook Page. Zernio handles its own app permissions; Creator Hub's Meta app configuration is not used for this path.
- Authorize the exact registered username and grant analytics permissions. Zernio's consent may also include publishing/comments/messages; Creator Ledger does not call those APIs. Do not describe the provider's grant as strictly read-only.
- `POST /v1/posts/sync-external` with `{accountId}` and no individual URL for recent native discovery.
- `GET /v1/analytics?accountId=...&platform=instagram&source=all&...` for paginated counters and metadata.
- `isAd` on **analytics list post rows**, not inside the numeric analytics object. It is an incomplete detection signal, not an organic certification. There is no documented guarantee of complete Instagram paid-delivery detection.

Sources: [Instagram](https://docs.zernio.com/platforms/instagram), [connections](https://docs.zernio.com/guides/connecting-accounts), [external discovery](https://docs.zernio.com/analytics/sync-external-posts), [analytics](https://docs.zernio.com/core/analytics), [ad detection changelog](https://docs.zernio.com/changelog), [pricing](https://docs.zernio.com/pricing), [cache/rate limits](https://docs.zernio.com/guides/rate-limits).

These are documentation-backed capabilities. **Live Instagram OAuth, Reel discovery, counter freshness and renewal/reconnection remain unverified**. Mocked tests are not evidence of provider entitlement.

## Behavior

- `ZERNIO_INSTAGRAM_ENABLED=true` enables only Zernio Instagram connection starts/callbacks and automated tracking. It defaults off. Existing TikTok and direct Meta/YouTube accounts do not consult this flag. Worker reports `zernio_instagram_disabled` when paused. Disconnect remains available while disabled.
- Register **Instagram → Zernio**, rather than Direct API. Platform/profile/active state/expected username are verified server-side. A reconnect cannot silently change the previously saved provider account ID. Expiring, single-use connection tickets and the two-account reservation guard are retained.
- Only positively identified Reels are imported: `mediaProductType=REELS`, or an Instagram `/reel/` / `/reels/` permalink when product type is absent. Explicit other product types, photos, carousels and ambiguous feed videos are excluded. Native provider media IDs are retained, never replaced with URL shortcodes or Zernio database IDs. Unrecognized Reel shapes must be investigated before broadening filters.
- Snapshots, daily/final-six-hour sampling, duplicate prevention, 168-hour eligibility, New York accounting, 24-hour Zernio closing follow-up, versioned rules and manual payout approvals use the existing engine.
- Ad status is stored in each post's existing tracking JSON, independently of snapshot sampling. `true` adds `suspected_paid_promotion` to the admin attention overview. `false` adds no ad-related review requirement. Missing/null records unknown and adds no ad-related review requirement. Neither is organic proof. A later observation updates the recorded status; existing finalized payouts are not rewritten.
- Public counters remain uncertain. Existing organic/cutoff evidence and final approvals remain required; no new evidence or approval step is imposed solely for absent ad detection. No ad-account connection is required or requested.
- No database migration, new dependency, scheduler change, or Meta credential change is required.
- This is **not a Meta-to-Zernio source migration**. Existing registered handles cannot be duplicated. Do not disconnect a populated direct Meta account to test this: its existing deletion workflow erases API-derived source data. Use a different Instagram handle for the pilot. A real provider transition needs a separate retention-aware plan.

## Validation with one Netlify deployment

1. Run local automated checks first; these use mocked APIs/disposable databases and need no production credentials or deployments. Do not run the local dashboard against production to create test records.
2. In Zernio's connected accounts view, confirm only the existing TikTok account occupies the allowance. Do not disconnect it, add a card, connect an ad account, or authorize a paid plan.
3. When ready for the pilot, set server-only `ZERNIO_INSTAGRAM_ENABLED=true` in Netlify **Project configuration → Environment variables**, Production / Functions runtime (or all scopes). Keep the existing `ZERNIO_API_KEY`, `APP_URL=https://creatorhub.h2adigital.com`, Supabase variables, Meta/Google credentials, encryption key and `CRON_SECRET`. Keep `INSTAGRAM_ORGANIC_VIEWS_VERIFIED=false`.
4. Deploy the reviewed code **once**, manually. No SQL is required. Supabase Cron continues POSTing the existing authenticated `/api/internal/jobs` every five minutes.
5. As administrator, create/use a test creator and campaign, register a **new** Professional Instagram handle with provider **Zernio**, and map it to the campaign effective before the test Reel's publication. Do not change the existing Meta account or TikTok provider. Click **Connect instagram** and open/copy the returned private provider authorization link for that creator.
6. Complete Zernio's Instagram consent with the exact account. The callback is **`https://creatorhub.h2adigital.com/api/connections/callback`** plus the generated private ticket. Do not use `/api/oauth/instagram/callback`; that remains Meta's direct callback. No Creator Hub Meta dashboard changes are needed. If Zernio enforces redirect allowlisting for your key/workspace, allow this HTTPS origin/path. Do not record/share the ticket.
7. Confirm the connected account and two-account usage. Zernio's `GET /v1/accounts/{accountId}/health` should show `canFetchAnalytics=true`; inspect through a secure server-side client or provider tooling without exposing the key.
8. Publish a native Reel in Instagram. Let Cron process the automatically queued first job, then hourly discovery. Inspect the admin sync diagnostics and imported native ID, publication timestamp, campaign, 168-hour deadline, and Reel-only selection. Photos/Stories should not import. Existing eligible Reels can validate discovery without a new upload; older videos cannot validate in-window collection.
9. Let views change and allow provider caching to refresh (roughly hourly; some insights lag). Confirm later snapshots according to daily sampling, then hourly near cutoff. A 200 or unchanged cached counter alone is not evidence of fresh analytics. No code deployment or repeated manual Sync is needed between observations.
10. Finish a seven-day test and inspect cutoff/organic review plus draft compensation. Check TikTok remains connected and syncing, and Google/Meta routes still work. Test wrong-account, reconnect and disconnect only with disposable test data when explicitly ready; do not disconnect production accounts merely to complete this checklist.

If a free-slot, permission or billing gate occurs, stop and inspect it; do not upgrade automatically. To pause the pilot later set the flag false through your deployment process. Existing records/connections are retained and Meta tracking is unaffected.
