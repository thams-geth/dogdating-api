# Implementation ledger

Updated: 8 October 2026. API_PLAN.md is the overall inventory; OpenAPI documents delivered routes.

| Module | State | Evidence / remaining work |
| --- | --- | --- |
| Baseline | Complete | Express/TypeScript, PostgreSQL migrations; d0b4746 |
| Research/API plan | Complete, launch mode provisional | Research sources and 16-module journey; 898efff |
| M01 lifecycle core | Complete | Countries/bootstrap, numeric update guidance, readiness/errors; f4236eb |
| M01 rollout/content extensions | Planned | Waitlist enrollment, staff release administration, enforced update gates; bootstrap legal-version hints remain unconfigured |
| M02 auth/session core | Complete for local development | OTP, rotation/reuse, logout/all, sessions, private me; 23e75eb |
| M02 production/recovery | Planned | SMS + DLT, shared throttling, security audit events, phone-change/recovery |
| M03 consent/onboarding | Complete as a prerequisite engine | Immutable published documents, acceptance/withdrawal, live progress, active dog, preferences; 5da00c6 |
| M04 household/dog profile core | Complete | Ownership, roles/invites, drafts, breed mix, structured temperament, preferences/schedule, gated publishing, pause, memorialisation, beacons |
| M04 manual location | Complete | Public area lookup; consented household city selection/read/clear; roles, 24-hour limit and live onboarding checks |
| M04 GPS/transfer extensions | Planned | Encrypted GPS/displaced anchor and two-party transfer; M06 now provides impression-scoped profile projection |
| M05 private photo foundation | Complete for local development | Real JPEG/PNG uploads, checksum/type/size checks, EXIF removal, status/order/deletion and retryable cleanup; pending moderation only |
| M05 verification intake / health metadata | Complete as a foundation | Request/status/withdrawal, requester permissions, deduplication, limits and private self-reported health records; no badges granted |
| M05 production integrations | Planned | Object storage, scan/moderation, approved-photo delivery, identity/document provider, signed webhooks and authorized reviewer grants |
| M06 home/discovery foundation | Complete for opt-in development | Home/tasks, city-only metadata feed, signed snapshots/impressions, live publisher eligibility, bilateral blocks/preferences, profile projection and durable exposure limits |
| M11 blocking foundation | Complete | Private paginated block list, idempotent block/unblock; existing cross-household matches/conversations close |
| M07 connections | Development core complete | Impression decisions, quotas, matching, withdrawal/unmatch; 072065f |
| M08 messaging | Development text/realtime complete | Encrypted bodies, sequences, recovery, ticketed sockets; fa26512; production KMS/attachments pending |
| M09 notifications | Foundation complete | Durable inbox, preferences, encrypted devices; f5a4d46; push delivery worker/provider pending |
| M10 meetups | Core implemented | Places, proposals, attendance and reviews; extensions/groups/video and operations pending |
| M11–M12 remaining launch modules | In progress / planned | Reports/privacy/support and staff operations |
| M13–M16 growth/expansion | Planned | Billing, country expansion, optional breeding/human dating/live safety |

## Latest local verification

- Typecheck/build passed; 8 unit/HTTP tests and 65 PostgreSQL integration tests passed (73 total).
- New M03 tests cover persisted progress, immutable documents, current-version acceptance, withdrawal, selected-dog authorization and expiring evidence.
- New M04 tests cover household ownership, phone-bound/expired/single-use invitations, concurrent final-owner protection, private dog access, membership revocation, dates/allowlists, breed evidence, questionnaire/preferences/schedule validation, cursor scoping, publication and beacon lifecycle.
- Migrations through 0018. Integration tests run against waggle_api_test only. Fresh migration application and repeated migration checks are part of the test setup/CI.
- 71 OpenAPI operations. YAML, operation IDs and local references are checked; full schema conformance remains a later gate.
- CI is configured but has not run remotely. No push or deployment performed.

## Explicit gaps and decisions

No reviewed legal text is seeded; public policy reads return 404 until published documents exist. Test policy/media/verification records are labeled fixtures confined to the test database. Onboarding can persist drafts but cannot finish in an ordinary local account until required media, consent, location and verification records exist. Self-declared adulthood never grants a verified badge.

OTP and invitations do not send real SMS. OTP needs explicit local terminal mode; household invitation tokens are shared manually. IP rate limits are per process; phone OTP limits are database-backed. Exact household location and secrets are absent from new household/dog responses.

M04 is the household/profile core, not every endpoint in the full plan. Current temperament input is versioned dimensions; twelve-question scoring is not delivered. Profile changes reset publication, and identity/breed changes invalidate dog verification evidence. Future discovery must check current consent, pauses, membership, blocks and verification; `publication_state='published'` alone is insufficient.

The launch-mode question remains unanswered. Playdates/walks are provisional; this does not authorize opening breeding or owner dating.

## Next session

Build M07 likes/connections with impression validation, live bilateral blocks, atomic matching and idempotency; then M08 messaging. Keep public discovery gates closed until production dependencies are ready. Before enabling a provider, document credentials/configuration, callback verification, storage restrictions and production availability. Keep legal text, actual launch city and provider selection as explicit inputs rather than fabricated configuration.

## Definition of module completion

Validate inputs and resource permissions, run relevant tests/typecheck/build, document implemented contracts and limits, update README/memory, and create a focused module commit. Mark submodules or external-provider dependencies explicitly rather than claiming the full product is complete.

Photo foundation: MEDIA_MODE=local is opt-in and forbidden in production. npm run media:cleanup processes up to 100 expired/deleted objects per run. No pending photo content is served; no moderation approval route exists. Cleanup scheduling and production object storage are not configured. Seven photo tests cover real image processing, authorization, corruption, replay, expiry, ordering, deletion and cleanup retry.

Verification intake: provider=NULL, pending/awaiting_provider_setup. No document uploads, callbacks or grants. Six additional database tests cover deduplication, caller binding, rate limits, withdrawal, role revocation, dates, cursors and health-evidence deletion. Any future health eligibility query must exclude deleted_at records, check verified_at, and evaluate expiry live. Any provider callback must recheck subject membership, request state and current dog identity before granting evidence.

## Frontend handover requirement

All 16 modules have docs/handovers/Mxx.md, with current status, screen flow and wireframe. Implemented operations have request/response shapes, examples, permissions, success/error codes and client handling. Planned contracts are explicitly unavailable. npm run docs:handovers generates from OpenAPI, source errors and scripts/handover-notes.mjs; npm run check:handovers checks drift (also configured in CI).

Location verification: five database tests cover public rollout/search/cursor semantics, current consent, country/role checks, concurrent throttling, deletion and live readiness. Manual location stores metro_id only; it never generates precise distance or GPS claims. Consent withdrawal remains per-user and does not delete shared location.

Blocking tests cover private lists, cursor scope, validation, reciprocal concurrency, idempotency and persistent match/conversation closure after unblock. M06 feed/profile enforcement is implemented; future relationship/message operations must check live blocks.

Discovery verification: ten integration tests cover live consent/publisher/verification/photo/account gates, household-wide block directions, matching filters, whole-city opt-in, scoped and expired tokens, stable pagination, changed context, durable quotas and truthful home states. New dog publications record published_by. Old publications with no publisher stay hidden until republished. Source-provided identity verification and reviewed legal content are not fabricated.

Remaining discovery gaps: cloud photo delivery/moderation, provider verification and account activation, public rollout, GPS/distance matching, full home counters and automated cleanup scheduling. DISCOVERY_MODE=development is off by default and forbidden in production; bootstrap flags remain false. A city-only opt-in explicitly overrides radius filtering with unknown distance.

## M07 connections delivered (8 October 2026)

Impression-bound pack interests/passes, sent/received likes, withdrawal, atomic mutual connections, unmatch and free daily entitlements are implemented. Migration 0019 adds durable interest budgets and idempotency receipts. Social writes serialize with blocking. Development discovery prerequisites remain required; production integrations remain unavailable. See docs/handovers/M07.md for contracts and wire diagram. Next: M08 messaging.

## M08 text messaging delivered (8 October 2026)

Encrypted text messages, deduplicated sends, bigint sequence history, private read markers, mute/archive and development WebSockets with single-use tickets are implemented. Migration 0020. MESSAGE_KEY is separate, opt-in and forbidden in production; KMS and attachments remain unavailable. Socket history polls PostgreSQL every two seconds; REST is authoritative. See docs/handovers/M08.md. Next: M09 notifications.

## M09 notification foundation delivered (8 October 2026)

Atomic match/message inbox events, private read markers, preferences and encrypted session-bound device registration are implemented. Migration 0021. Push jobs remain awaiting_provider; external push delivery/retry/dead-letter worker is still pending. Logout revokes registrations. See docs/handovers/M09.md. Next: M10 meetups.

## M10 meetup core delivered (9 October 2026)

Reviewed-place lookup/suggestions, two-guardian proposals with retry identities, optimistic accept/counter/decline, cancellation, self-declared attendance and delayed reviews are implemented. Migration 0022 cancels active meetups when connections end. Private incident notes are encrypted and never exposed to participants. No reviewed places, staffed safety response, video/groups, extensions or reminder scheduler are fabricated. See docs/handovers/M10.md. Next: M11 reports/support/privacy.
