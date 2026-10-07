# Implementation ledger

Updated: 8 October 2026. Endpoint inventory lives in API_PLAN.md; this file records delivered behavior.

| Module | State | Evidence / next work |
| --- | --- | --- |
| Baseline | Complete | Express/TypeScript scaffold, 11 applied SQL migrations, health/readiness/breeds; commit d0b4746 |
| Research and API plan | Complete, launch mode provisional | RESEARCH.md and API_PLAN.md; country expansion and full journey covered |
| M01 app lifecycle core | Complete | Bootstrap/countries, numeric update guidance, fail-closed readiness, request IDs and HTTP validation; 6 HTTP tests pass |
| M01 remaining content/rollout | Planned | Areas/waitlist, published legal documents, staff release controls and enforced minimum-build gate |
| M02 authentication/session core | Complete for local development | OTP signup/login, refresh rotation/reuse revocation, logout/all, own-session list/revoke, GET/PATCH me; 17 PostgreSQL integration tests |
| M02 production/recovery extensions | Planned | Production SMS + DLT, shared IP/device rate limits, security audit events, phone-change/recovery, provider reconciliation |
| M03 consent/onboarding core | Complete | Versioned immutable policy text, acceptance/withdrawal evidence, resumable prerequisites, active-dog ownership checks and private preferences; 6 new database tests |
| M04–M12 launch modules | Planned | Implement in dependency order in API_PLAN.md |
| M13–M16 growth/expansion | Planned | Feature/country gates apply |

## Definition of module completion

Routes and contracts are documented; migrations reviewed/applied; input validation and authorization tested; relevant tests/typecheck/build pass; README and memory updated; focused commit created. A development provider must be labeled and must not silently operate in production. Mark a partially delivered module as partial and list missing endpoints.

## Session handoff

Next: implement M04 households/dog profiles. Keep consent text/version and launch city as explicit unresolved inputs; local development can use labeled drafts, public launch cannot. Research and product docs supersede the external NestJS plan for this Express repository. Pending founder answer: playdates only vs playdates+breeding vs human dating at launch.

## Latest verification

- Typecheck and build passed. Eight unit/HTTP tests and 17 PostgreSQL integration tests passed.
- Fresh test database applied migrations 0001–0012; second migration run was a no-op.
- Integration tests use waggle_api_test only. Development database retains its own data.
- OpenAPI has 14 operations across 13 paths; YAML/local-reference validation is available. Full schema conformance remains a later gate.
- CI configured, not remotely executed. No push/deployment performed.

## Explicit gaps

M01 does not yet deliver areas/waitlists, reviewed legal documents, staff release controls or request-level update enforcement. M02's default provider is disabled; local setup explicitly enables terminal codes for synthetic users. No live SMS, adult verification, social login, phone-change/recovery or product onboarding is claimed. IP throttling is per process; OTP phone cooldown and attempt limits persist in PostgreSQL. Existing raw phone columns require infrastructure encryption/access controls and an explicit retention policy before launch.

M03 verification: build/typecheck and all 23 integration tests passed before commit. Migrations now include 0013. Published legal text is intentionally unseeded; completion requires evidence from future media, location and verification modules. No public launch eligibility is manufactured.
