# Implementation ledger

Updated: 10 October 2026. API_PLAN.md is the overall inventory; OpenAPI documents delivered routes.

| Module | State | Evidence / remaining work |
| --- | --- | --- |
| Baseline | Complete | Express/TypeScript, PostgreSQL migrations; d0b4746 |
| Research/API plan | Complete, launch mode provisional | Research sources and 16-module journey; 898efff |
| M01 lifecycle core | Complete | Countries/bootstrap, numeric update guidance, readiness/errors; f4236eb |
| M01 rollout/content extensions | Waitlist and release/legal operations implemented | Private waitlist; staff release policy and legal publishing; conditional product update gate implemented |
| M02 auth/session core | Complete for local development | OTP, rotation/reuse, logout/all, sessions, private me; 23e75eb |
| M02 phone changes / production | Phone changes implemented; integrations pending | Recent-auth destination proof and revocation; SMS/DLT, distributed limits and optional recovery remain pending |
| M03 consent/onboarding | Complete as a prerequisite engine | Immutable published documents, acceptance/withdrawal, live progress, active dog, preferences; 5da00c6 |
| M04 household/dog profile core | Complete | Ownership, roles/invites, drafts, breed mix, structured temperament, preferences/schedule, gated publishing, pause, memorialisation, beacons |
| M04 manual location | Complete | Public area lookup; consented household city selection/read/clear; roles, 24-hour limit and live onboarding checks |
| M04 GPS/transfer extensions | Two-party transfer implemented | Manual owner transfer works; encrypted GPS/displaced anchor remains planned |
| M05 private photo foundation | Complete for local development | Real JPEG/PNG uploads, checksum/type/size checks, EXIF removal, status/order/deletion and retryable cleanup; pending moderation only |
| M05 verification intake / health metadata | Complete as a foundation | Request/status/withdrawal, requester permissions, deduplication, limits, private self-reported health records and provider-neutral callback/replay ledger; no real provider adapter or production badges |
| M05 production integrations | Planned | Object storage, scan/moderation, approved-photo delivery, identity/document provider, vendor-specific signed callback adapter and authorized reviewer grants |
| M06 home/discovery foundation | Complete for opt-in development | Home/tasks, city-only metadata feed, signed snapshots/impressions, live publisher eligibility, bilateral blocks/preferences, profile projection and durable exposure limits |
| M11 blocking foundation | Complete | Private paginated block list, idempotent block/unblock; existing cross-household matches/conversations close |
| M07 connections | Development core complete | Impression decisions, quotas, matching, withdrawal/unmatch; 072065f |
| M08 messaging | Development text/realtime complete | Encrypted bodies, sequences, recovery, ticketed sockets; fa26512; production KMS/attachments pending |
| M09 notifications | Provider-neutral relay complete | Durable inbox, encrypted devices, leased retry queue; real provider/scheduler pending |
| M10 meetups | Two-party flow implemented | Places, proposals, consented extensions, reminders, attendance, reviews; external scheduler/groups/video pending |
| M11 safety/privacy | Scoped export foundation implemented | Reports/support/appeals and restricted privacy OTP; encrypted account_data_v1 export; full legal response/erasure pending |
| M12 staff operations | Core case tooling implemented | OIDC/MFA, roles, reports/incidents/support/appeals, place/release/legal review and redacted audit browsing; provider/privacy tooling pending |
| M13–M16 growth/expansion | Planned | Billing, country expansion, optional breeding/human dating/live safety |

## Latest local verification

- Typecheck/build passed; 9 unit/HTTP tests and 122 PostgreSQL integration tests at the latest full run.
- New M03 tests cover persisted progress, immutable documents, current-version acceptance, withdrawal, selected-dog authorization and expiring evidence.
- New M04 tests cover household ownership, phone-bound/expired/single-use invitations, concurrent final-owner protection, private dog access, membership revocation, dates/allowlists, breed evidence, questionnaire/preferences/schedule validation, cursor scoping, publication and beacon lifecycle.
- Migrations through 0036. Integration tests run against waggle_api_test only. Fresh migration application and repeated migration checks are part of the test setup/CI.
- 169 OpenAPI operations. YAML, operation IDs and local references are checked; full schema conformance remains a later gate.
- CI is configured but has not run remotely. No push or deployment performed.

## Explicit gaps and decisions

No reviewed legal text is seeded; public policy reads return 404 until published documents exist. Test policy/media/verification records are labeled fixtures confined to the test database. Onboarding can persist drafts but cannot finish in an ordinary local account until required media, consent, location and verification records exist. Self-declared adulthood never grants a verified badge.

OTP and invitations do not send real SMS. OTP needs explicit local terminal mode; household invitation tokens are shared manually. IP rate limits are per process; phone OTP limits are database-backed. Exact household location and secrets are absent from new household/dog responses.

M04 is the household/profile core, not every endpoint in the full plan. Current temperament input is versioned dimensions; twelve-question scoring is not delivered. Profile changes reset publication, and identity/breed changes invalidate dog verification evidence. Future discovery must check current consent, pauses, membership, blocks and verification; `publication_state='published'` alone is insufficient.

The launch-mode question remains unanswered. Playdates/walks are provisional; this does not authorize opening breeding or owner dating.

## Next work

See [remaining work and inputs](REMAINING_WORK.md). M07–M12 foundations, home counters, waitlist and phone changes are delivered. Production integrations and privacy processing remain incomplete; M13–M16 are not implemented. Do not mark the whole app complete or public-launch ready.

## Definition of module completion

Validate inputs and resource permissions, run relevant tests/typecheck/build, document implemented contracts and limits, update README/memory, and create a focused module commit. Mark submodules or external-provider dependencies explicitly rather than claiming the full product is complete.

Photo foundation: MEDIA_MODE=local is opt-in and forbidden in production. npm run media:cleanup processes up to 100 expired/deleted objects per run. No pending photo content is served; no moderation approval route exists. Cleanup scheduling and production object storage are not configured. Seven photo tests cover real image processing, authorization, corruption, replay, expiry, ordering, deletion and cleanup retry.

Verification intake: provider=NULL, pending/awaiting_provider_setup. No document uploads, callbacks or grants. Six additional database tests cover deduplication, caller binding, rate limits, withdrawal, role revocation, dates, cursors and health-evidence deletion. Any future health eligibility query must exclude deleted_at records, check verified_at, and evaluate expiry live. Any provider callback must recheck subject membership, request state and current dog identity before granting evidence.

## Frontend handover requirement

All 16 modules have docs/handovers/Mxx.md, with current status, screen flow and wireframe. Implemented operations have request/response shapes, examples, permissions, success/error codes and client handling. Planned contracts are explicitly unavailable. npm run docs:handovers generates from OpenAPI, source errors and scripts/handover-notes.mjs; npm run check:handovers checks drift (also configured in CI).

Location verification: five database tests cover public rollout/search/cursor semantics, current consent, country/role checks, concurrent throttling, deletion and live readiness. Manual location stores metro_id only; it never generates precise distance or GPS claims. Consent withdrawal remains per-user and does not delete shared location.

Blocking tests cover private lists, cursor scope, validation, reciprocal concurrency, idempotency and persistent match/conversation closure after unblock. M06 feed/profile enforcement is implemented; future relationship/message operations must check live blocks.

Discovery verification: ten integration tests cover live consent/publisher/verification/photo/account gates, household-wide block directions, matching filters, whole-city opt-in, scoped and expired tokens, stable pagination, changed context, durable quotas and truthful home states. New dog publications record published_by. Old publications with no publisher stay hidden until republished. Source-provided identity verification and reviewed legal content are not fabricated.

Remaining discovery gaps: cloud photo delivery/moderation, provider verification and account activation, public rollout, GPS/distance matching, automated cleanup scheduling. DISCOVERY_MODE=development is off by default and forbidden in production; bootstrap flags remain false. A city-only opt-in explicitly overrides radius filtering with unknown distance.

## M07 connections delivered (8 October 2026)

Impression-bound pack interests/passes, sent/received likes, withdrawal, atomic mutual connections, unmatch and free daily entitlements are implemented. Migration 0019 adds durable interest budgets and idempotency receipts. Social writes serialize with blocking. Development discovery prerequisites remain required; production integrations remain unavailable. See docs/handovers/M07.md for contracts and wire diagram. Next: M08 messaging.

## M08 text messaging delivered (8 October 2026)

Encrypted text messages, deduplicated sends, bigint sequence history, private read markers, mute/archive and development WebSockets with single-use tickets are implemented. Migration 0020. MESSAGE_KEY is separate, opt-in and forbidden in production; KMS and attachments remain unavailable. Socket history polls PostgreSQL every two seconds; REST is authoritative. See docs/handovers/M08.md. Next: M09 notifications.

## M09 notification foundation delivered (8 October 2026)

Atomic match/message inbox events, private read markers, preferences and encrypted session-bound device registration are implemented. Migration 0021. Push jobs remain awaiting_provider; external push delivery/retry/dead-letter worker is still pending. Logout revokes registrations. See docs/handovers/M09.md. Next: M10 meetups.

## M10 meetup core delivered (9 October 2026)

Reviewed-place lookup/suggestions, two-guardian proposals with retry identities, optimistic accept/counter/decline, cancellation, self-declared attendance and delayed reviews are implemented. Migration 0022 cancels active meetups when connections end. Private incident notes are encrypted and never exposed to participants. No reviewed places, staffed safety response, video/groups or reminder scheduler are fabricated. Constrained two-party extensions and a manual reminder pass are available. See docs/handovers/M10.md. Next: M11 reports/support/privacy.

## M11 safety and privacy foundation (9 October 2026)

Private reports, encrypted support, notices/appeals, purpose-bound restricted privacy OTP, and export/deletion request tracking are implemented. Migration 0023. Deletion requests revoke normal access and close social relationships immediately; full erasure and export processing remain needs_review, never completed. Existing restricted accounts can use Privacy-Token only for safety/privacy routes. See docs/handovers/M11.md. Next: M12 staff operations.

## M12 staff operations foundation (9 October 2026)

Separate OIDC/MFA staff auth, database roles, exclusive report claims/audited narratives, support replies, suspend/reinstate, independent appeals, public-place reviews and job counts are implemented. Migration 0024. No staff identities are seeded; configure SSO and explicitly provision approved subjects. Verification grants, full release/legal administration, push and privacy processing remain unavailable. See docs/handovers/M12.md.

Home integration: GET /home now reports account-wide live connection/unread message/upcoming meetup/unread notification counts with current access and blocks enforced. Messaging stays unavailable/null without encryption configuration.

M01 waitlist extension (9 October 2026): authenticated area opt-in/list/withdrawal, five-area cap, same-country rollout checks and idempotency; migration 0025. Launch notification delivery remains unavailable.

M02 phone-change extension (9 October 2026): recent original-family sign-in plus caller-bound destination OTP, durable failed-attempt limits, collision protection, audit and full session/device/privacy-token revocation. Migration 0026. Same-country only; no account merging.

## Scoped account exports (9 October 2026)

M11 now queues account_data_v1 exports, processes encrypted snapshots with npm run privacy:exports, and serves owner-only/recent-auth JSON downloads for 24 hours. Migration 0027. Explicit exclusions include photo file bytes, others’ content, shared documents, provider records and internal notes; this is not a full legal-response archive. Size failures go to review without truncation. Deletion remains unprocessed/needs_review.

## Two-party dog transfers (9 October 2026)

M04 now supports owner-requested, named-recipient/token-accepted same-country household transfers. Migration 0028. Transfers reset publication, selection, matching opt-in and dog verification, close old social relationships and cancel incomplete uploads; completed dog profile/photos/health metadata move with explicit sharing acknowledgement. Dog access rechecks the locked household after transfer, and active-dog selection serializes with social writes.

## Release and legal operations (9 October 2026)

M12 now has dedicated release_ops/legal_ops roles, optimistic audited release-policy edits and reviewed legal draft/publish endpoints. M01 bootstrap reads stored release guidance and current published legal-version hints, failing closed for an invalid/missing stored policy. Migration 0029. No actual legal content/store rollout was published. Hard API update enforcement and country expansion remain pending.

## Push queue relay (9 October 2026)

Provider-neutral push relay now has durable leases, per-installation receipts, timeout/backoff, invalid-token handling, live permission/preference checks, quiet-hour deferral and dead-letter state. Staff operations can inspect/retry jobs. Migration 0030. Actual provider credentials/adapter wiring and scheduling are still absent; pushAvailable remains false.

### M10 extension and reminder update (9 October 2026)

Migration 0031 adds consented two-party extension requests and durable reminder receipts. POST /v1/meetups/{id}/extend and /extensions/{extensionId}/respond use current revisions; requests expire and cannot exceed four total hours or ten requests per meetup. The meetup detail includes pendingExtension. Only recorded participants receive meetup notifications. The optional `npm run meetups:reminders` pass expires unaccepted proposals and creates one generic inbox reminder for accepted meetups near start; external scheduling is not installed. Meetups whose windows ended no longer occupy the three-future-meetup limit. Reviewer response workflow, groups/video and operational safety response remain pending.

### M12 meetup incident reviewer queue (9 October 2026)

Migrations 0032–0033 create private case entries for incident reviews and backfill prior eligible records. Provisioned reviewer staff can list metadata, exclusively claim, read the assigned encrypted note and dismiss/escalate with a reason code. Every read/action is audited without copying private notes. This does not automatically enforce an account action or provide emergency response; real reviewer staffing remains a launch dependency.

### M12 bounded audit browsing (9 October 2026)

`GET /admin/v1/audit-events` lets provisioned operations staff browse seven days by default or a chosen past range up to 31 days, with exact filters and scoped descending ID pagination. It returns event metadata only; before/after JSON is withheld. Each browse creates its own audit entry. Partition/retention scheduling and monitoring remain operational work.

### Bounded operations maintenance (9 October 2026)

`npm run maintenance:run` now performs one overlap-safe pass for audit partition provisioning, bounded discovery cleanup, expired realtime tickets/privacy tokens, and meetup reminders/proposal expiry. It uses a database advisory lock and returns `already_running` if another pass owns it. It emits counts only. An external scheduler, monitoring, media cleanup, encrypted export processing, push provider and reviewed audit retention remain separate operational tasks.

### M05 live verification expiry (9 October 2026)

A bounded expiry worker revokes lapsed grants with an audited `expired` reason. When a guardian has no other live tier, it clears the stored adult-verified flag, pauses dogs published by that guardian and removes their active beacons. Live onboarding/discovery already check grant expiry without waiting for the pass. `npm run verification:expire` runs it alone; `npm run maintenance:run` includes it. No grant creation, provider review or account activation is implied.

### M05 provider callback boundary (10 October 2026)

Migration 0036 adds a replay ledger. `POST /webhooks/verification` receives raw JSON only when an injected provider verifier authenticates the exact bytes and returns a normalized, typed event. It atomically checks request state, requester eligibility and current dog ownership, records the provider event, then applies approved/rejected/needs_more_info. An approved event grants an expiring subject tier; exact replay is idempotent, while an event ID reused with different bytes is rejected. The server bootstrap injects no verifier, so the route returns 503. A timestamped HMAC signer exists only inside disposable integration tests; it is neither production evidence nor a vendor protocol. The provider contract, assurance policy, real credentials, document handling and account activation remain outstanding. See [production boundary](PRODUCTION_READINESS.md).

### M12 maintenance status (9 October 2026)

Migration 0034 keeps one latest maintenance status record. The operations-only jobs endpoint now exposes run state, timing, aggregate counts and a redacted failure code. Interrupted runs remain visible as stale `running`; a new pass replaces them. No external scheduler has been deployed.

### M11 own meetup incident status (10 October 2026)

`GET /v1/me/incident-reviews` and `/{id}` expose a reporter’s own case state and timestamps through normal or restricted safety authentication. The response omits private notes, peer identities, staff assignments and internal reason codes. Historical status remains accessible after block/unmatch; unknown or another user’s case returns 404. This does not create an emergency or response-time promise.

### M11/M12 reviewed help publishing (10 October 2026)

Migration 0035 adds immutable, versioned en-IN help articles. Legal operations staff can create drafts with a review reference, publish after explicit confirmation, read audited details and retire articles. Publishing a new version atomically retires the old public version for its slug. Public list/detail return published content only. No guidance text or external deletion page is seeded; actual editorial review remains required before publication.

### M01 conditional app build gate (10 October 2026)

Product routes now use `X-App-Platform` and `X-App-Build` against the persisted release policy when staff raise either minimum above 1. Obsolete builds receive 426 `update-required`; missing/malformed headers receive 400 once enforcement is active. Bootstrap, public help/legal, auth and safety/privacy/recovery routes remain available. With both minimums at 1, existing development requests without headers still work. A missing/invalid policy fails closed. Staff store-availability confirmation is an attestation, not automated verification or deployment.
