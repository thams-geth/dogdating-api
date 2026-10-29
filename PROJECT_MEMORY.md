# Project memory

Updated 17 October 2026. Read with docs/IMPLEMENTATION.md and docs/REMAINING_WORK.md.

## User instructions

- Build an India-first dog social/dating backend in TypeScript, Express and PostgreSQL, with later country expansion.
- Continue modules automatically; commit each completed module with a meaningful message.
- Maintain the API plan, implementation ledger, this memory and per-module mobile/web handovers with methods, statuses, errors, request/response contracts, examples, Mermaid flows and wireframes.
- No remote push/deployment requested. Do not fabricate provider success, verified evidence, legal content or completion of privacy processing.
- Use the fixed development-only sign-in code for valid supported phone numbers while real SMS remains deferred. Private S3 photo persistence is now implemented; moderation and approved delivery remain production launch blockers.
- Pack/playdates remains the provisional shared-platform scope. Breeding, owner dating and live safety have no explicit product approval.

## Source of truth

Latest user instructions → docs/IMPLEMENTATION.md and docs/REMAINING_WORK.md for actual state → docs/API_PLAN.md for planned scope. docs/APP_API_FLOWS.md provides the cross-module mental model and diagrams. docs/openapi.yaml describes delivered HTTP routes. docs/handovers includes all 16 modules; unimplemented growth modules remain labeled planned.

Generate handovers from scripts/handover-notes.mjs and OpenAPI using npm run docs:handovers. Add route mapping in scripts/generate-handovers.mjs; verify npm run check:handovers. Do not hand-edit generated module files.

Historical source: /Users/thamaraiselvan/Dog dating/waggle-plan and waggle. Their NestJS plan does not override this Express repository.

## Environment

- Repo: /Users/thamaraiselvan/ReactProject/dogdating-api.
- Own PostgreSQL container dogdating-api-postgres, port 5433, database/user waggle. Dedicated integration DB waggle_api_test is disposable; tests refuse other database names.
- Ports 5432/6379 belong to campusone; never touch unrelated infrastructure. Redis 6380 exists but is not used.
- Migrations through 0038; applied SQL is immutable. Forward migrations only.
- `.env.development` and `.env.production` are ignored; their committed `.example` templates contain no secrets. setup:dev generates/retains the local auth secret and enables terminal-only OTP for synthetic numbers. setup:prod-env creates a fail-closed production file with blank database/secret values. Environment-specific npm commands load only their named file; application config no longer implicitly reads legacy `.env`.
- With NODE_ENV=development and OTP_MODE=development, any valid supported sign-in phone uses fixed code 000000 only after a fresh request. Privacy and phone-change codes remain random. Production cannot instantiate the development sender.
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

## Two-party dog transfers (9 October 2026)

M04 now supports owner-requested, named-recipient/token-accepted same-country household transfers. Migration 0028. Transfers reset publication, selection, matching opt-in and dog verification, close old social relationships and cancel incomplete uploads; completed dog profile/photos/health metadata move with explicit sharing acknowledgement. Dog access rechecks the locked household after transfer, and active-dog selection serializes with social writes.

## Release and legal operations (9 October 2026)

M12 now has dedicated release_ops/legal_ops roles, optimistic audited release-policy edits and reviewed legal draft/publish endpoints. M01 bootstrap reads stored release guidance and current published legal-version hints, failing closed for an invalid/missing stored policy. Migration 0029. No actual legal content/store rollout was published. Hard API update enforcement and country expansion remain pending.

## Push queue relay (9 October 2026)

Provider-neutral push relay now has durable leases, per-installation receipts, timeout/backoff, invalid-token handling, live permission/preference checks, quiet-hour deferral and dead-letter state. Staff operations can inspect/retry jobs. Migration 0030. FCM HTTP v1 adapter maps UNREGISTERED/quotas and accepts Google ADC credentials via a manual push:deliver pass. Real Firebase project/credentials, production key wrapper, scheduler and APNs/Web Push adapters remain absent; pushAvailable stays false.

## Meetup extensions and reminders (9 October 2026)

M10 adds two-party extension requests with revision and duration caps and a reminder/expiry pass. Migration 0031. Only recorded participants receive meetup events. Worker must be externally scheduled; it writes generic inbox reminders once, not proof of attendance or emergency response. No real scheduler was installed.

## Meetup incident reviewer queue (9 October 2026)

M12 reviewer role now has audited, exclusive claim/read/dismiss/escalate APIs for private meetup review incidents. Migrations 0032–0033 create new cases and backfill previous incident/private-note reviews. Decisions do not automatically suspend users or claim operational response. Readiness requires migration 0035.

## Audit metadata browsing (9 October 2026)

M12 operations role can browse redacted audit metadata in bounded past windows, exact filters and scoped cursors. Responses include normalized from/to for paging. No before/after JSON is returned. Every browse is audited. Audit retention/partition scheduler remains pending.

## Operations maintenance pass (9 October 2026)

`npm run maintenance:run` runs a single bounded pass under a database advisory lock: current/next audit partitions, old discovery snapshots/exposure rows, expired realtime tickets/privacy tokens, and up to 50 meetup reminders/expiries. Another pass returns already_running. It has no scheduler deployment and does not process media, exports, push or audit retention. Dedicated commands for those remain separate.

## Verification tier expiry (9 October 2026)

M05 has a bounded, audited expiry sweep for lapsed grants. With no other current guardian tier it clears is_adult_verified, pauses that guardian’s published dogs and removes their beacons. Live onboarding/discovery gate on expiry even before the sweep. maintenance:run invokes it; verification:expire runs it alone. It never creates grants or replaces evidence/provider review.

## Maintenance observability (9 October 2026)

Migration 0034 persists only the latest maintenance run state/timestamps/aggregate counts or generic failure code. M12 GET /admin/v1/jobs exposes it to operations staff; null means never run, stale running suggests interruption. No scheduler has been deployed.

## Own meetup incident status (10 October 2026)

M11 now exposes reporter-only incident case list/detail under /v1/me/incident-reviews, including restricted Privacy-Token access after block, unmatch or suspension. It returns status/timestamps only, not notes, peer identity, staff assignment or internal reasons. OpenAPI now has 161 HTTP operations.

## Reviewed help workflow (10 October 2026)

M11 public en-IN help list/detail now reads published articles only. M12 legal_ops can create reviewed-reference drafts, publish a version (retiring prior public slug version), and retire it. Published content is immutable, all staff access audited, no content seeded. Migration 0035.

M05 provider-neutral callback boundary uses migration 0036 and `POST /webhooks/verification`. A selected verifier must authenticate raw bytes/timestamp/source before normalization. Default server has no verifier and responds 503. Disposable integration tests use a fixture-only timestamped HMAC signer. Transaction records replay IDs/hashes, checks current request/account/dog ownership and applies approved/rejected/needs_more_info; approved creates an expiring tier. No production provider, evidence policy, document upload, reviewer decisions or account activation is connected. See docs/PRODUCTION_READINESS.md. OpenAPI 169 HTTP operations.

## Conditional app update gate (10 October 2026)

M01 now checks X-App-Platform/X-App-Build on product routes against live persisted release policy. Once staff raise either minimum above 1, both headers are required; old builds get 426 update-required. Bootstrap, help/legal, auth, reports/support, blocks, privacy/deletion, appeals and incident review status remain reachable. Both minimums still default to 1. Missing/invalid policy fails 503. No store rollout was performed.

## Nonpublic area administration (10 October 2026)

M01 city_ops can list India metros and change only prospect/seeding/waitlist/gated via versioned, audited PATCH. Migrations 0037–0038 add rollout version metadata; 0038 removes the staff FK so deprovisioning/test truncation cannot cascade into metros. Public opening, country administration and waitlist delivery remain unimplemented. Moving out of seeding resets affected dog publication to draft and cancels beacons; live onboarding/discovery also use the current state. Returning to seeding never republishes dogs automatically. OpenAPI has 171 operations. Use any valid supported phone and 000000 for development sign-in; photo/SMS providers remain deferred.

## Deployment architecture and S3 persistence (19 October 2026)

The deployment plan proposes separate AWS dev/prod accounts in Mumbai, ECS Fargate + ALB, private RDS PostgreSQL, separate private S3 buckets, ECR, Secrets Manager, GitHub OIDC and scheduled ECS tasks. The user created dev bucket `waggle-dev-media-123456789012`, kept it private, added lifecycle cleanup and created the media IAM policy. The API supports `MEDIA_MODE=s3` with `MEDIA_BUCKET` and `MEDIA_REGION`, storing processed JPEGs under `photos/` through the AWS credential chain. ECS must grant its task role object access; no AWS keys belong in environment files. A Node 22 multi-stage Dockerfile is checked in; ECR/ECS/RDS/IaC, moderation and approved-photo delivery remain pending. Hosted dev can use the OTP fixture with synthetic data; production still has no real sign-in sender.
