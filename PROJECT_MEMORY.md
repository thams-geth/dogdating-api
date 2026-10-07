# Project memory

Last updated: 7 October 2026. Read this with docs/IMPLEMENTATION.md at the start of a session.

## Confirmed user decisions

- Build a backend-only dog dating/social app. Launch in India, expand to other countries later.
- Use TypeScript + Express (explicitly requested), PostgreSQL. Do not reintroduce NestJS.
- Working repository: /Users/thamaraiselvan/ReactProject/dogdating-api.
- Research and plan the full API journey before feature implementation. Start implementing when the plan is written.
- Commit each completed module with a meaningful message. Maintain Markdown docs and this memory file.

## Current product assumptions

- Pack/playdates first is provisional. A question about breeding vs human dating was sent; no answer was present when these notes were written. Shared platform work may proceed.
- One launch city at a time; Bengaluru is only existing seed data, not a founder-approved launch city.
- Phone OTP, adult guardian accounts, households with multiple dogs/guardians. Like → mutual match → chat → meetup.
- Android client exists externally; backend changes need an explicit contract and later client reconciliation.

## Sources of truth

1. Latest user decisions override repository docs.
2. docs/API_PLAN.md is the current Express API plan; docs/RESEARCH.md has dated primary sources.
3. docs/IMPLEMENTATION.md records actual status; planned paths are not implemented endpoints.
4. External reference: /Users/thamaraiselvan/Dog dating/waggle-plan and /Users/thamaraiselvan/Dog dating/waggle. These are historical input, not authoritative when conflicting with the current user/plan.

## Local environment

- Node, npm and Docker available. PostgreSQL container dogdating-api-postgres uses localhost:5433, database/user waggle. Redis configured on 6380 but not required by current routes.
- Ports 5432 and 6379 belong to the user's campusone project; never stop or overwrite it.
- Migrations 0001–0011 copied from old backend and applied to local Waggle DB. Preserve them; add forward migrations.
- Baseline committed as d0b4746. No remote push/deployment requested.

## Next work

Consult docs/IMPLEMENTATION.md for the current completed modules and exact continuation point. Production SMS, verification, media storage, app store IDs, public domains, reviewed legal text and launch city are still open product/operations inputs. Do not invent credentials, verified claims or production readiness.
