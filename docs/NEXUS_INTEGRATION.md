# ORD.NET / Nexus integration (schema v48)

`/profile` lets a connected wallet preview its ORD.NET profile, then explicitly
publish its name/avatar and connection to that one ordinals wallet. Nothing is
published by connecting a wallet, opening a preview, or purchasing an inscription.
The wallet menu and post-purchase receipt link to these settings.

The server-only `/api/profile/ordnet` route uses the existing signed buyer cookie
and encrypted ORD.NET session cookie. It fetches ORD.NET `/api/v1/me` with the
user's bearer token, checks the exact wallet binding and strict `isPublic === true`,
and never trusts client-supplied profile metadata. POST requires explicit consent
and the previewed profile ID; POST/DELETE require an exact Origin. Responses are
private/no-store. Payment addresses, private/sibling bindings, and tokens are not
stored in the public identity tables. Each additional wallet must sign in and
publish separately. DELETE works without an ORD.NET token or upstream availability.

The existing marketplace enable flag and buyer-session secret are required for
the profile API. No new credentials are needed. ORD.NET's current Trading API
requires 100,000 confirmed sats at the signing payment address to issue a bearer
token. This is an upstream API eligibility rule, not a payment or a Nexus fee.
Do not suggest transferring funds as part of onboarding; users who do not qualify
can continue using the Archive and their server's verification flow.

Schema v48 adds `ordnet_public_profiles` and `ordnet_public_wallets`, plus
`public_profiles` and `public_wallet_links` read views. Existing real Matrica
identities retain priority. An explicitly shared ORD.NET identity can take
precedence over an automatic Matrica address-name placeholder. Provider IDs stay
separate (`ordnet:<profile id>`); matching names never merge identities. Existing
Matrica tables and clustering calibration data are untouched.

Public identities drive holder pages, leaderboards/distribution counts, search,
activity/notification display, internal-transfer labels, and website badges.
Only explicitly published wallets aggregate for an ORD.NET identity; heuristic
wallet siblings are excluded. Badge recomputation runs after publishing/removing.
The legacy `roles_earned.matrica_user_id` column can contain namespaced public
identity IDs; it has no Matrica foreign key. Community Purchases financial identity,
authorization, receipts, and signed ownership are deliberately unchanged.

Publication is a local consent snapshot. Changing a wallet's visibility or
unlinking it on ORD.NET does not automatically withdraw Archive sharing. Users
remove sharing here; update/republish fetches authoritative current metadata.
There is no background Nexus wallet lookup or webhook in this integration.

`NEXUS_DISCORD_ENABLED=true` optionally enables Nexus role-setup instructions in
purchase receipts. Leave unset/false until the OMB Discord administrators have
actually configured and verified Nexus. This flag does not install a Discord bot
or assign roles. Public Archive sharing is available independently and never
claims that a profile is Nexus/Discord verified.

Before enabling Nexus Discord guidance, confirm OMB collection/eye-color metadata,
multi-wallet rule combinations, role removal timing, and treatment of loaned or
marketplace-staged inscriptions with ORD.NET. The Archive uses `effective_owner`
for its holdings/badges; Nexus may use different custody rules. Community Purchase
positions are not direct inscription holdings. Partner features to request are a
read-only consent-based profile connection without Trading API funding eligibility,
eligibility attestations, Discord-link status, revocation, and link/unlink webhooks.

Deployment needs no historical identity backfill and no new cron. Back up SQLite
before starting the new image; v47→v48 is additive and transactional. A rollback to
the prior image can leave the additive tables in place. Do not lower `user_version`.
Smoke-test `/profile` disconnected/connected, preview/publication/private-wallet
rejection, wallet switching, removal with an expired ORD.NET token, holder/search/
leaderboard/badge updates, mobile receipt scrolling, keyboard focus and Escape.
Test against a deliberately selected wallet; never publish a user's identity as
part of operator QA without their explicit consent.

## Release verification

This integration is prepared against production main
`fa05bba6b34ac7f284abee751e4bd3a3c9fd2aad`. It preserves the existing v47 data
accuracy migration and adds the independent v48 identity migration. No historical
identity backfill is required.

Automated verification covers publication/withdrawal, per-wallet consent, private
wallet rejection, claimed Matrica priority, automatic-shell fallback, namespace
isolation, clustering isolation, stats/search/badge consistency, and server guards.
Subagent review is required before release, and live browser checks after deployment.

Authenticated wallet publication must be checked by a consenting wallet owner;
operator smoke tests must not publish identities or sign financial transactions.
Leave `NEXUS_DISCORD_ENABLED` off until the Discord administrators confirm support.
