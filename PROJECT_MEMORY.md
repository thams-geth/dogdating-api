# Project memory

Last updated: 8 October 2026. Read with docs/IMPLEMENTATION.md at the start of a session.

## Confirmed user decisions

- Backend-only dog dating/social app. India first, then other countries.
- TypeScript + Express + PostgreSQL; do not reintroduce NestJS.
- Repository: /Users/thamaraiselvan/ReactProject/dogdating-api.
- Research and plan the whole API journey, then implement modules. Commit each completed module with a meaningful message; maintain docs and this memory.
- Latest user instruction: continue next module and create mobile/web handovers for every module, with API/status/error/request/response details and wire diagrams. No remote push/deployment requested.

## Product assumptions and open inputs

- Pack/playdates first remains provisional: the question about breeding/owner dating has no recorded answer. Shared platform work is authorized.
- One metro at a time; Bengaluru is seed data, not a confirmed launch city.
- Adult guardian accounts, phone OTP, multi-dog/multi-guardian households; likes → mutual connection → chat → meetup.
- Production SMS/DLT, verification/media providers, legal text/translations, domains/store IDs and final launch city remain unresolved.
- Never fabricate legal acceptance, age/identity verification or production readiness. New accounts remain pending; live onboarding readiness is distinct from identity account status.

## Sources of truth

Latest user decisions → docs/API_PLAN.md → docs/IMPLEMENTATION.md for actual state. docs/RESEARCH.md contains dated sources. docs/openapi.yaml and docs/requests.http describe implemented endpoints.

Historical input lives in /Users/thamaraiselvan/Dog dating/waggle-plan and /Users/thamaraiselvan/Dog dating/waggle. The old NestJS plan does not override the Express repository. Its Android client is a draft and needs contract reconciliation later.

## Environment

- PostgreSQL: dogdating-api-postgres, localhost:5433, database/user waggle. Redis configured on 6380, not used yet.
- Ports 5432/6379 belong to campusone. Do not touch unrelated containers/databases.
- Migrations 0001–0011 inherited; 0012 auth metadata, 0013 consent/onboarding, 0014 dog drafts/invitations; 0015 private photo uploads; 0016 verification intake; 0017 manual location; 0018 discovery. Add migrations; never rewrite applied SQL.
- TEST_DATABASE_URL must name a dedicated DB ending in _test. Local test DB waggle_api_test uses port 5433. Tests clear its fixture identity/household data.
- npm run setup:dev generates an ignored local secret and opts into terminal-only OTP for synthetic numbers. Do not print secrets or enable this in production.
- A previous compiled server may still own port 3000. Do not assume it serves the latest code; use npm run dev or restart only the known Waggle process.

## Delivered modules / commits

- d0b4746 baseline; 898efff research/plan; f4236eb app lifecycle; 23e75eb auth/session core.
- 5da00c6 consent and resumable onboarding. Published policy rows are immutable; no legal content is seeded. Adult declaration is not verification. Active dog selection always rechecks household membership. Live missing steps override historical completedAt.
- Household/dog core follows 5da00c6; use git log for exact hash. Roles, manual phone-bound invitations, last-owner protection, private dog drafts, declared breed mix, structured temperament, filters/schedule, gated publication/pause/memorialisation/beacons.
- Household writes lock the household before checking membership. Multi-resource operations lock user before household; avoid reversing this order. Profile edits reset publication; identity/breed changes revoke dog tiers.
- Impression-scoped discovery profiles and manual city selection are implemented. Precise GPS capture, transfer and twelve-question temperament scoring remain pending.
- Local checks: 8 unit/HTTP + 65 PostgreSQL tests passed; build/typecheck and OpenAPI checks passed. CI configured, not remotely run. No deployment.

## Next work

M07 likes/connections, then M08 messaging; production media moderation and verification integrations still required before opening discovery. Read the implementation ledger first. New public discovery must enforce live consent, blocking, visibility and verification; a published row alone does not authorize disclosure. Keep module docs and commits current.

## Photo foundation handoff

60673c3 implements private photo uploads. Opt-in MEDIA_MODE=local / MEDIA_LOCAL_DIR, local adapter forbidden in production. Only re-encoded JPEG bytes stored, no public content route, moderation remains pending. Use npm run media:cleanup regularly (100 items/run). Verification requests/status/withdrawal and health metadata now implemented; find module commit after 60673c3 in git log. Provider stays unconfigured: requests record intent only and never grant tiers. Production object storage/moderation/providers and optional GPS capture remain pending.

## Verification handoff

Guardian requests bind to caller; dog requests require editor membership. Active requests deduplicate, max 3 new requests/user/day. Health metadata is explicitly self_reported; dates validated, 100 live/dog and 10 new/dog/day. Removing reviewed evidence revokes health tiers and publication. Future health eligibility must check deleted_at, verified_at and live expiry; future callbacks must recheck membership, request state and current identity. No identity documents or numbers are accepted. Tests now total 73; OpenAPI has 71 operations. Next concrete shared-platform task: likes/connections with current eligibility and blocks enforced.

## Location and developer handover

GET /app/areas; GET/PUT/DELETE /households/{id}/location implemented. source=manual_area, precision=city, current location consent required. City selection is an explicit no-GPS path; metro_id only, inherited anchor cells/origins cleared. Do not derive precise distance buckets from city selection. Area changes serialized per household and limited to 24h; identical save is idempotent, clear retains deadline. Both change/clear reset publication and cancel beacons. Bengaluru remains development-only seed data.

User requires handover per module from now on. All 16 have docs/handovers/Mxx.md, plus COMMON.md and index with end-to-end wire flow; planned modules clearly have no callable contracts. Keep OpenAPI, scripts/handover-notes.mjs and API_PLAN current; run docs:handovers and check:handovers before each module commit. CI includes drift check. This requirement is also in AGENTS.md.

## Blocking foundation

ec2f80b: M11 POST/GET /me/blocks and DELETE /me/blocks/{userId} implemented. Max 500 outgoing, private list, idempotent, reciprocal blocks use sorted user locks. Existing cross-household matches/conversations close; unblock never restores. Shared household membership is not removed. M06 now enforces blocks on feed/profile reads.

## Discovery handoff

M06 home/feed/empty-reason/discovery-preferences and impression-scoped profile implemented after ec2f80b; use git log for exact hash. DISCOVERY_MODE=development + AUTH_SECRET, off by default and forbidden in production. Bootstrap flags remain false. Cards provide approved-photo metadata only, mediaDelivery=unavailable. Home future counters are explicitly not_implemented/null.

0018 adds published_by, allow_city_only=false default, live eligibility views, snapshot sessions and daily exposure rows. Publishing attributes current editor; old publications need republish. Actor and publisher need active account, is_adult_verified, current guardian tier and current four policy consents. Never fabricate these in ordinary local accounts. Both dogs require allowCityOnly=true, with distance unknown and radius filtering explicitly not applied.

Snapshot IDs ranked by energy/style/size/same-timezone schedule; 200 max, ten-minute signed cursor, every page/profile rechecks current eligibility and bilateral household blocks. Limits 60 snapshots/hour and 200 distinct dog exposures/user/UTC day. npm run discovery:cleanup clears day-old sessions/prior-day reads; no scheduler. M07 must verify impression scope/expiry AND recheck eligibility/blocks and serialize relationship writes consistently with blocking; signed impressions are not standing permission. Existing blocked/ended matches are excluded and never silently restored.

## M07 connections delivered (8 October 2026)

Impression-bound pack interests/passes, sent/received likes, withdrawal, atomic mutual connections, unmatch and free daily entitlements are implemented. Migration 0019 adds durable interest budgets and idempotency receipts. Social writes serialize with blocking. Development discovery prerequisites remain required; production integrations remain unavailable. See docs/handovers/M07.md for contracts and wire diagram. Next: M08 messaging.

## M08 text messaging delivered (8 October 2026)

Encrypted text messages, deduplicated sends, bigint sequence history, private read markers, mute/archive and development WebSockets with single-use tickets are implemented. Migration 0020. MESSAGE_KEY is separate, opt-in and forbidden in production; KMS and attachments remain unavailable. Socket history polls PostgreSQL every two seconds; REST is authoritative. See docs/handovers/M08.md. Next: M09 notifications.
