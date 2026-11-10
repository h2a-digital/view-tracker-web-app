# Dashboard UX and safe record management

**Current component system and Analytics:** see [product experience](product-experience.md). Radix primitives and cmdk are now added for consistent controls. The earlier no-new-dependencies statement below describes the prior iteration.

**Profile update:** profile metadata is now automatic across supported providers. The global YouTube refresh action described in the historical follow-up below has been replaced by scheduled refresh and per-account Details controls. See [social profile rollout](social-profiles.md) and apply migration 202611090003 after 002.

This change updates the existing dashboard components/styles; no UI framework, dependency, payment integration or scheduler is added. Existing local Zernio Instagram pilot changes are retained.

## Before deployment

1. Confirm the production dashboard is still schema **5**, with `America/New_York` accounting. Apply only `supabase/migrations/202611090001_dashboard_management.sql`, manually, before deploying this code. Do not reset/reseed or rerun older migrations. This optional capability leaves schemaVersion at 5.
2. The migration adds nullable/default-false archive fields to creators/accounts, service-only management/shared-grant/metadata RPCs, and protective triggers. It deletes no existing records, changes no provider grants, and leaves existing history/financial protections intact. It briefly locks workspace revision metadata; an administrator operation in flight can need refresh/retry. Older documents omitting archive fields remain compatible. Do not perform administrative writes during migration/deployment.
3. Deploy manually, then refresh open administrator tabs. No OAuth scopes or Cron changes are needed. The YouTube metadata follow-up below adds an optional server-only API key. Keep the existing Instagram/Zernio flag at its intended pilot value.
4. Check desktop and mobile navigation, forms, confirmations, account menus, keyboard focus and reduced-motion behavior. Automated tests do not replace visual acceptance; the agent's browser connection was unavailable during this run.

## Identity display

YouTube titles, handles (only when Google supplies an actual @handle) and avatars are captured from the already-authorized channel response during OAuth. Existing connections still refresh metadata through the daily account identity check, requesting snippet alongside id. A controlled on-demand refresh now also supports existing and unconnected registrations; see the follow-up below. Missing/invalid metadata falls back to a generic channel label plus creator identity; technical channel IDs remain in account details.

Metadata lives in the account's existing integration JSON and is erased by the existing direct-provider lifecycle. New metadata writes verify the immutable connected channel ID and use workspace revision locking. The API field definitions are documented at https://developers.google.com/youtube/v3/docs/channels. Avatar loading uses HTTPS Google thumbnail hosts, a no-referrer policy and an initials fallback.

## Clear operation boundaries

- **Disconnect** stops future synchronization through the existing provider flow. For Zernio it sends DELETE /v1/accounts/{id}, retaining local history. This is the provider operation that releases a remote connection; deleting/archiving only a local record does not free a Zernio slot. Pricing counts active connections with daily proration; verify workspace usage before relying on a released slot. No live disconnect was performed to test slot-release timing.
- **Direct Google/Meta Disconnect** retains the existing source erasure/revocation behavior. Its confirmation now clearly explains irreversible source deletion and preservation/redaction of settled monetary records. Known Meta shared-grant accounts are listed first and require a separate explicit checkbox; the server refuses disconnection without confirmation. Google can revoke other tokens under the same app grant; this is disclosed, without claiming complete Google grant-impact enumeration.
- **Remove unused** permanently removes only unused records. Posts or compensation references block deletion. Apps can remove empty campaigns and unreferenced rules, but campaign assignments block removal. Creators must have their unused accounts removed first. Accounts must be disconnected, with no live provider credential or pending remote revocation. Pending Zernio invitations must finish/expire first. Zernio connections are checked read-only before local removal/archival to avoid stranding an active remote slot.
- **Archive** keeps history and financial records. Creator/account archival requires associated accounts to be disconnected first. Apps archive their campaigns; creators archive their disconnected accounts. Current routing intervals close at the archival instant; future-dated assignments block archival instead of silently rewriting their dates. Historical posts/rules/calculations are not recomputed by the operation. Local pending invitations/jobs are invalidated/cancelled where applicable.
- **Restore** restores availability, not ended routing or provider access. Restore an archived parent creator before restoring an account. App restoration does not reactivate its archived campaigns; campaign restoration is paused. Review/recreate current campaign routing and explicitly reconnect when appropriate. Erased provider source records are never resurrected.

Archive menus and **Show archived** are provided on the dashboard. Financial history remains available through posts and payout views. Source deletion can leave protected historical tombstones, so such accounts/creators remain archival records rather than being hard-deleted. Raw test posts with history are intentionally not bulk-deleted.

Zernio references: https://docs.zernio.com/pricing, https://docs.zernio.com/accounts/delete-account. No new paid service is required.

## Interaction feedback

Promise-returning actions use shared loading buttons with immediate duplicate-click protection and visible failures. Forms retain server validation and error messages. Interactive network calls have a 30-second timeout; timeout feedback explicitly warns that a server mutation may still finish and advises refresh before retrying. No success is shown before the mutation response succeeds.

Sync feedback distinguishes queue acceptance from collection. While an administrator-requested job is pending, the page checks existing dashboard data every 30 seconds for up to five minutes. This never triggers additional provider synchronization. Completion directs the administrator to diagnostics rather than claiming counters are fresh. Timeout leaves a clear Automation health instruction. Normal unattended Cron/provider cadence is unchanged.

The workspace and automation-health views have skeletons/loading feedback, and refresh preserves usable existing data. Forms, drawers, navigation, status surfaces and menus share dark styling, short transitions, visible focus states, disabled/press feedback and reduced-motion overrides.

## YouTube metadata and loading follow-up

The original generic labels were caused by missing cached metadata: only OAuth and daily account checks populated it. Registration and workspace GET/Refresh never queried channel details. Registered accounts therefore had no path to a title until connecting. The shared loading control also prepended a spinner without hiding/replacing its existing icon.

Before deploying the follow-up, manually apply **202611090002_youtube_channel_metadata.sql**, after **202611090001_dashboard_management.sql**, on the existing schema-5 database. No existing data is deleted at migration time. The new cache RPC updates only metadata JSON with registered username/connected-ID fences; it cannot connect accounts, restore erased data, change permissions, or alter payouts. The existing retention sweep is preserved behind a private function and extended to remove public-only cached metadata older than 29 days, without deleting the account registration. This covers accounts that never receive OAuth credentials. No new scheduled job is added.

To backfill existing accounts immediately, open **Social accounts → Refresh YouTube details**. Alternatively open a YouTube account's **Details → Refresh channel details**. The request is admin-only and same-origin, batches up to 50 channel IDs, persists names/handles/avatars, and returns the updated dashboard. Existing encrypted YouTube OAuth credentials can read this public metadata for connected and registered channels. No reconnect, consent change, daily worker run, or page-load API request is required. Missing/deleted channels remain gracefully unavailable; source-erased or archived accounts cannot be backfilled. Technical IDs remain in Details. Repeated refreshes within one minute reuse the cache; normal workspace Refresh only reads the database. New registrations attempt this same metadata lookup once, without making successful registration depend on Google availability.

If no usable connected YouTube account exists, optionally create a Google Cloud API key restricted to **YouTube Data API v3** and configure **YOUTUBE_DATA_API_KEY**. Locally, put it in `.env.local` and restart Next.js. On Netlify, set it in Production / Functions runtime (or all scopes). Never use NEXT*PUBLIC*, expose it in the browser, commit it, or include it in a query URL. The implementation sends it in X-Goog-Api-Key. An OAuth client ID/secret alone is not a public API key. The key does not authorize tracking, Analytics access or compensation, and public metadata cannot verify ownership. Existing OAuth identity verification remains unchanged.

Google references: [channels.list](https://developers.google.com/youtube/v3/docs/channels/list), [authorization](https://developers.google.com/youtube/registering_an_application), [secure API-key headers](https://docs.cloud.google.com/docs/authentication/api-keys-use). Live metadata lookup remains an administrator-run validation step; implementation tests mock provider responses and use disposable PostgreSQL.

Loading buttons now reserve the icon's existing dimensions and position and show exactly one spinner, hiding all original action icons while pending. Action labels stay constant during loading; text remains visible and text-only forms reserve a small icon slot to avoid width changes. Non-action text controls do not acquire unnecessary icon spacing. Buttons retain disabled/busy semantics and reduced-motion styling. Simple manual Refresh no longer shows a redundant workspace progress bar or marks the whole page busy; background refreshes leave content intact. Initial workspace/health skeletons and longer sync-job status remain.
