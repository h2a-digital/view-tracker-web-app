# Repository and Git history security audit

Audit date: November 8, 2026. Scope: the public organization-owned GitHub repository, this checkout's additional local history/objects, and pending Netlify compatibility changes. No secrets were printed, sent to an external scanner or tested against live APIs. No credentials, GitHub settings, Git history, Supabase data or hosting services were changed. The official scanner was installed temporarily outside the repository.

## Result and rotation guidance

**No exposed production credential was identified in the material scanned. No credential rotation is required based on these findings.** This is a scoped result, not proof that a credential has never appeared in a deleted remote reference, fork, issue, log or external system.

| Credential                                    | Finding                                                                                                           | Rotation indicated by this audit?                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Supabase secret/service-role key              | Current local value absent from scanned files and local Git blobs; no matching real secret detected by Gitleaks   | No                                                                                           |
| Zernio API key                                | Current local value absent from scanned files and local Git blobs; no matching real secret detected               | No                                                                                           |
| CRON_SECRET                                   | Current local value absent from scanned files and local Git blobs; test tokens are fixtures                       | No                                                                                           |
| Supabase publishable key/project URL          | Current local values absent from scanned source/history; these are public identifiers, not privileged credentials | No                                                                                           |
| Administrator email                           | Current local value absent from scanned files/local Git blobs                                                     | Not a credential; no current admin address found in source                                   |
| Previous marketing app SMTP/other credentials | Historical code references environment-variable names; no actual credential values detected                       | No exposure found; old credentials could not be compared to values no longer present locally |

The ignored `.env.local` contains real configuration. It is not tracked, was not found in available Git history, and was excluded from the scanner's publication-candidate directory. Its values were used only for an in-memory exact-match comparison against Git/worktree contents. No values, prefixes or hashes are recorded here. `.env.example` contains blank settings and a localhost example. `.gitignore` excludes environment files, local Netlify output, dependencies and generated builds. Never upload `.env.local`, database dumps, evidence exports, payout CSVs or local diagnostic reports to GitHub.

If GitHub secret-scanning alerts or another source subsequently shows exposure, revoke/rotate that affected credential first. Replace the Supabase server key and deployment environment if that key leaked; replace the Zernio API key if it leaked; replace CRON_SECRET in both hosting configuration and Supabase Vault if it leaked. Removing a line or rewriting history alone does not revoke a credential. Do not rotate unaffected keys or disconnect the healthy TikTok account solely because this repository is public.

## What was scanned

- A fresh, unauthenticated HTTPS **read-only mirror of the public remote**: two reachable commits, `b3b7ee2` and `6d6ddd5`, and one advertised branch/ref. Remote files were not treated as equivalent to an old cached tracking branch.
- All three locally available reachable commits, including the separate baseline checkpoint `8254c39`, plus local reflog-reachable and unreachable blobs. The original checkout is not shallow. In total, **237 unique local Git blobs** were inspected.
- **78 tracked or non-ignored untracked publication-candidate files** in the pending working tree, including Netlify changes. These counts precede adding this audit report and its documentation links.
- **Gitleaks v8.30.1**, downloaded from its [official release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) and verified against the published SHA-256 checksum. Four scans: remote Git history, local Git/reflog history, the publication-candidate directory, and exported local Git blobs including unreachable objects. **All four returned zero findings.** Scanner reports were fully redacted and kept in temporary local storage.
- An additional local scan for known current environment-value matches, common token formats, private-key blocks, credential-bearing URLs and sensitive literal assignments. Matches were reviewed: the localhost APP_URL is not a secret, and `https://user:password@example.com` is an intentionally invalid URL test fixture. No matching private credential was found.
- The existing production browser assets (`.next/static`): all 27 generated files were checked for exact matches to the local Supabase server key, Zernio key and CRON_SECRET; none were present. This supplements source review and does not replace checking the final Netlify deployment.
- Historical environment/key-like filenames, previous marketing contact/unsubscribe code, current fixtures, operational SQL and documentation. Only `.env.example` appeared among historical environment/key-like filenames; no tracked private key or environment secret file was found.

No scanner performed online credential validation. An absent finding does not establish that a token is active, inactive or impossible for a scanner to miss.

## Sensitive information other than credentials

- The public commits include **Versel's initial compensation rates/cap and the public TikTok test handle `@versel.app`** in configuration/documentation. Those are business details, not authentication secrets. They remain visible in history even if removed later. Keep the repository public only if that disclosure is acceptable; this audit does not change repository visibility or the requested initial compensation configuration.
- Sample domain/test records and synthetic fixtures are present. No real creator contact list, account token export, metric-history export, evidence file, bank information, finalized payout ledger or current administrator address was identified in scanned source. Runtime records remain in Supabase.
- Git commit author/committer names and an email address are public Git metadata. They are not login credentials. Use a GitHub noreply author address for future commits if preferred; changing it would not erase existing history.
- The **local-only** baseline `8254c39` contains the previous marketing site's founder/contact links, profile photo and screenshots. These paths were **absent from the freshly fetched public remote's reachable history**. They remain in local history/objects, so do not publish checkpoint refs or use `git push --mirror` to publish this checkout. Normal publication of the current main branch does not include that separate root commit. No history rewrite or local object deletion was performed.

## Limits and manual GitHub checks

A Git mirror audits advertised Git refs and reachable objects. It does not expose GitHub's private security alerts, deleted server-side refs, forks, caches, issue/PR comments, release assets, GitHub Actions logs/artifacts, organization secrets or third-party copies. Local orphaned objects do not prove those objects were ever published.

Before deployment, the repository owner should review **GitHub → Security → Secret scanning** for any historical alerts and enable available push protection/secret scanning. [Public repositories support GitHub's secret-protection features](https://docs.github.com/en/code-security/getting-started/github-security-features); this agent did not change those live settings. Inspect Actions artifacts/logs and any previously shared database exports if applicable. Do not paste credentials into issues, screenshots, logs or build troubleshooting output. Any confirmed exposure from those sources supersedes the rotation guidance above.

No credential exposure was found that blocks the prepared Netlify Free deployment. The public organization-owned repository also removes the previously conditional private-organization Git integration concern. Deployment, production variables, schema-version verification, Supabase Vault/Cron setup and HTTPS verification remain manual steps in the [deployment guide](production-deployment.md).
