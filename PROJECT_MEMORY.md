# Project memory

Updated 9 October 2026. Read with docs/IMPLEMENTATION.md and docs/REMAINING_WORK.md.

## User instructions

- Build an India-first dog social/dating backend in TypeScript, Express and PostgreSQL, with later country expansion.
- Continue modules automatically; commit each completed module with a meaningful message.
- Maintain the API plan, implementation ledger, this memory and per-module mobile/web handovers with methods, statuses, errors, request/response contracts, examples, Mermaid flows and wireframes.
- No remote push/deployment requested. Do not fabricate provider success, verified evidence, legal content or completion of privacy processing.
- Pack/playdates remains the provisional shared-platform scope. Breeding, owner dating and live safety have no explicit product approval.

## Source of truth

Latest user instructions → docs/IMPLEMENTATION.md and docs/REMAINING_WORK.md for actual state → docs/API_PLAN.md for planned scope. docs/openapi.yaml describes delivered HTTP routes. docs/handovers includes all 16 modules; unimplemented growth modules remain labeled planned.

Generate handovers from scripts/handover-notes.mjs and OpenAPI using npm run docs:handovers. Add route mapping in scripts/generate-handovers.mjs; verify npm run check:handovers. Do not hand-edit generated module files.

Historical source: /Users/thamaraiselvan/Dog dating/waggle-plan and waggle. Their NestJS plan does not override this Express repository.

## Environment

- Repo: /Users/thamaraiselvan/ReactProject/dogdating-api.
- Own PostgreSQL container dogdating-api-postgres, port 5433, database/user waggle. Dedicated integration DB waggle_api_test is disposable; tests refuse other database names.
- Ports 5432/6379 belong to campusone; never touch unrelated infrastructure. Redis 6380 exists but is not used.
- Migrations through 0026; applied SQL is immutable. Forward migrations only.
- .env is ignored. setup:dev generates the local auth secret and enables terminal-only OTP for synthetic numbers. No real SMS.
- An older server may own 3000. Do not assume latest compiled code is running. No restart/deployment was performed.

## Delivered development modules

- M01 bootstrap/countries/areas/breeds/update guidance, plus private area waitlist (dee3b40).
- M02 OTP/signup/login, refresh rotation/reuse, sessions/revocation/private profile; verified recent-auth phone changes (20c2323).
- M03 immutable policy acceptance/withdrawal and live resumable onboarding.
- M04 household roles/invitations, dog drafts/details/breeds/structured temperament/preferences/schedule/publication/pause/memorial/beacons; consented manual-city location.
- M05 private local photo upload/re-encode/checksum/order/deletion/cleanup; verification intent and self-reported health metadata. No automatic moderation/grants.
- M06 live-gated city-only discovery with signed feed snapshots/impressions (e1823e2); account-wide real home counters (fbb8bd7).
- M07 interest/pass quotas, idempotency, pending likes, atomic mutual matches and unmatch (072065f).
- M08 encrypted text, sequencing/deduplication, read/mute/archive and ticketed development WebSockets (fa26512).
- M09 durable inbox, preferences and encrypted session-bound device registration (f5a4d46). Push awaits provider.
- M10 reviewed-place proposals/counters, revision checks, attendance and delayed reviews (7d0145d).
- M11 blocks, encrypted reports/support, notices/appeals and restricted privacy OTP plus request tracking (425b241). Export/erasure NOT executed.
- M12 separate staff OIDC/MFA, DB roles, case claims/audits, support replies, suspend/reinstate/independent appeals, place review and job counts (737f2f0).

## Invariants

- Household permission checks lock the household before checking current membership. Multi-resource writes lock user before household; multi-household locks use sorted IDs.
- Social writes/blocks/chat/home use socialLock advisory lock BEFORE user/household locks. Development throughput is intentionally serialized; do not remove it without concurrency evidence.
- Discovery requires current caller and publisher consent/account/adult verification/current tier, eligible dogs, approved photos and both allowCityOnly=true. Distance is unknown; photos are metadata only. Publishing records published_by. Never seed ordinary accounts with fake evidence.
- Discovery tokens expire after ten minutes, bind caller/actor and never bypass live privacy checks. Quotas: 60 snapshots/hour and 200 distinct dogs/UTC day.
- Interest quota: 12 new interests/user/Asia-Kolkata day across dogs; no refunds. Ended/blocked matches never reopen. Conversations include original editors only and require current editor membership.
- MESSAGE_KEY is separate from AUTH_SECRET. Local AES-GCM wrapping is forbidden in production. Random per-conversation keys encrypt text; this is not E2EE. Missing key means unavailable, never plaintext fallback.
- WS /v1/realtime uses a one-use 30-second ticket in the first frame, not URL. Auth within 5 seconds, 15-minute connection lifetime, 2-second persisted-history polling; REST is authoritative.
- Inbox and awaiting_provider delivery intents commit with social events. Device tokens are encrypted, installation-bound and removed on session-family logout/revocation.
- Meetup mutations use revision checks; block/unmatch cancels active meetings in a DB trigger. Reviews reveal peer feedback only after both submit or seven days; private incident fields never leave participant APIs.
- Privacy-Token is OTP-purpose-bound and restricted to safety/privacy routes, including suspended users. It cannot authenticate normal product routes. Privacy-Status-Token allows only minimal request tracking.
- Deletion requests revoke sessions, pause publication and end relationships but remain needs_review. No file export or physical erasure has occurred.
- Phone changes require original family sign-in within 15 minutes and caller-bound destination proof; destination collisions never merge accounts. Success revokes all sessions/devices/privacy tokens, and requires sign-in to the new number.
- Staff issuer/JWKS/audience must be configured together over HTTPS. Require RS256/ES256, amr=mfa, auth_time within 15 minutes and provisioned active DB roles. No user role claim or seeded staff account grants access. Provisioning CLI is available but was not run on real staff.

## Next work and required inputs

See docs/REMAINING_WORK.md. Provider choices/credentials, reviewed legal/retention rules, actual launch city/store links/support staffing and optional-mode approval remain unresolved. An async provider question was already asked; no answer recorded. M13–M16 remain unimplemented, not implicitly approved or launched.

Continue authorized independent backend work without repeated permission requests. Integrations require real contracts/test credentials; do not invent them. All commits are local. Re-run relevant tests, typecheck/build and contract/handover checks before each module commit.

## Scoped account exports (9 October 2026)

M11 now queues account_data_v1 exports, processes encrypted snapshots with npm run privacy:exports, and serves owner-only/recent-auth JSON downloads for 24 hours. Migration 0027. Explicit exclusions include photo file bytes, others’ content, shared documents, provider records and internal notes; this is not a full legal-response archive. Size failures go to review without truncation. Deletion remains unprocessed/needs_review.
