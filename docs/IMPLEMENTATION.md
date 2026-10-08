# Implementation ledger

Updated: 8 October 2026. API_PLAN.md is the overall inventory; OpenAPI documents delivered routes.

| Module | State | Evidence / remaining work |
| --- | --- | --- |
| Baseline | Complete | Express/TypeScript, PostgreSQL migrations; d0b4746 |
| Research/API plan | Complete, launch mode provisional | Research sources and 16-module journey; 898efff |
| M01 lifecycle core | Complete | Countries/bootstrap, numeric update guidance, readiness/errors; f4236eb |
| M01 rollout/content extensions | Planned | Areas/waitlist, staff release administration, enforced update gates; bootstrap legal-version hints remain unconfigured |
| M02 auth/session core | Complete for local development | OTP, rotation/reuse, logout/all, sessions, private me; 23e75eb |
| M02 production/recovery | Planned | SMS + DLT, shared throttling, security audit events, phone-change/recovery |
| M03 consent/onboarding | Complete as a prerequisite engine | Immutable published documents, acceptance/withdrawal, live progress, active dog, preferences; 5da00c6 |
| M04 household/dog profile core | Complete | Ownership, roles/invites, drafts, breed mix, structured temperament, preferences/schedule, gated publishing, pause, memorialisation, beacons |
| M04 location/discovery/transfer extensions | Planned | Reviewed private location capture/anchor, public profile with block/privacy/anti-scraping checks; two-party transfer |
| M05 media/verification | Next | Actual upload pipeline and provider/manual-review grants needed to finish the app flow |
| M06–M12 launch modules | Planned | Home/feed, likes/connections, chat, notifications, meetups, privacy/support, staff operations |
| M13–M16 growth/expansion | Planned | Billing, country expansion, optional breeding/human dating/live safety |

## Latest local verification

- Typecheck/build passed; 8 unit/HTTP tests and 34 PostgreSQL integration tests passed (42 total).
- New M03 tests cover persisted progress, immutable documents, current-version acceptance, withdrawal, selected-dog authorization and expiring evidence.
- New M04 tests cover household ownership, phone-bound/expired/single-use invitations, concurrent final-owner protection, private dog access, membership revocation, dates/allowlists, breed evidence, questionnaire/preferences/schedule validation, cursor scoping, publication and beacon lifecycle.
- Migrations through 0014. Integration tests run against waggle_api_test only. Fresh migration application and repeated migration checks are part of the test setup/CI.
- 46 OpenAPI operations. YAML, operation IDs and local references are checked; full schema conformance remains a later gate.
- CI is configured but has not run remotely. No push or deployment performed.

## Explicit gaps and decisions

No reviewed legal text is seeded; public policy reads return 404 until published documents exist. Test policy/media/verification records are labeled fixtures confined to the test database. Onboarding can persist drafts but cannot finish in an ordinary local account until required media, consent, location and verification records exist. Self-declared adulthood never grants a verified badge.

OTP and invitations do not send real SMS. OTP needs explicit local terminal mode; household invitation tokens are shared manually. IP rate limits are per process; phone OTP limits are database-backed. Exact household location and secrets are absent from new household/dog responses.

M04 is the household/profile core, not every endpoint in the full plan. Current temperament input is versioned dimensions; twelve-question scoring is not delivered. Profile changes reset publication, and identity/breed changes invalidate dog verification evidence. Future discovery must check current consent, pauses, membership, blocks and verification; `publication_state='published'` alone is insufficient.

The launch-mode question remains unanswered. Playdates/walks are provisional; this does not authorize opening breeding or owner dating.

## Next session

Build M05 uploads/verification and the remaining private location prerequisite, then M06 discovery. Before enabling a provider, document credentials/configuration, callback verification, storage restrictions and production availability. Keep legal text, actual launch city and provider selection as explicit inputs rather than fabricated configuration.

## Definition of module completion

Validate inputs and resource permissions, run relevant tests/typecheck/build, document implemented contracts and limits, update README/memory, and create a focused module commit. Mark submodules or external-provider dependencies explicitly rather than claiming the full product is complete.
