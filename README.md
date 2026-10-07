# Waggle API

India-first dog social/matching backend built with TypeScript, Express and PostgreSQL. International rollout is part of the design.

## Plan and project memory

- [API plan](docs/API_PLAN.md): full user journey, endpoint inventory across 16 modules, data rules, implementation order and launch gates.
- [Research](docs/RESEARCH.md): dated primary sources and decisions drawn from them.
- [Implementation ledger](docs/IMPLEMENTATION.md): delivered modules, limitations and next work.
- [Project memory](PROJECT_MEMORY.md): user decisions, environment and future-session handoff.
- [OpenAPI](docs/openapi.yaml) and [HTTP examples](docs/requests.http): implemented endpoints only.

The provisional launch scope is dog playdates/walks. Breeding introductions and owner dating have separate rollout plans. The founder's launch-mode clarification is still pending; common platform work is underway.

## Local development

Requires Node 22+ and Docker. PostgreSQL uses port 5433 to coexist with other projects.

```sh
npm ci
npm run setup:dev
docker compose up -d postgres
npm run migrate
npm run dev
```

`setup:dev` creates/updates the ignored `.env`, generates a local authentication secret if absent and explicitly enables development OTP delivery. Use synthetic phone numbers: OTPs are printed to the local server terminal, and **no SMS is sent**. Authentication is disabled by default without this opt-in. The development sender cannot run in production. A production SMS adapter and DLT registration are still required.

If port 3000 is already occupied, stop your previous Waggle process or set `PORT` in `.env`. Redis is available in Compose on 6380 but is not yet used by these modules.

## Implemented endpoints

| Module | Endpoints |
| --- | --- |
| Health | `GET /v1/health`, `GET /v1/ready` |
| App lifecycle | `GET /v1/app/countries`, `GET /v1/app/bootstrap` |
| Reference data | `GET /v1/dogs/breeds` |
| Authentication | `POST /v1/auth/otp/request`, `/otp/verify`, `/refresh`, `/logout`, `/logout-all` (all under `/v1/auth`) |
| Device sessions | `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/{id}` |
| Private guardian profile | `GET /v1/me`, `PATCH /v1/me` |

Bootstrap example: `/v1/app/bootstrap?platform=android&buildNumber=1&countryCode=IN&locale=en-IN`. India is marked `development`; unbuilt product features remain disabled. Published store links, reviewed legal documents, rollout administration and enforced minimum-build gates are pending. Release policy is currently reviewed code in `src/modules/app/policy.ts`.

OTP signup and returning-user login share one flow. New accounts require a name and remain `pending` until future onboarding is completed. Access JWTs last 15 minutes; refresh families last 30 days. Serialize refresh calls on the client: reusing a rotated refresh token revokes its whole family. Logout/device revocation takes effect on subsequent authenticated requests. Profile edits cannot change verification, roles or account status.

Phone resend/attempt limits are persisted in PostgreSQL. IP limits are currently per process; shared rate limiting and a production SMS provider remain launch requirements. This is a development milestone, not a production-ready app.

## Checks

```sh
npm run typecheck
npm run build
npm test
npm run check:openapi

# Create once; tests clear authentication data in this dedicated test database.
docker exec dogdating-api-postgres createdb -U waggle waggle_api_test
TEST_DATABASE_URL=postgres://waggle:waggle@localhost:5433/waggle_api_test npm run test:integration
```

Integration tests refuse databases whose names do not end in `_test`. They verify migrations twice, OTP concurrency/lockout, token rotation/reuse, session ownership, logout and profile authorization using real PostgreSQL. GitHub Actions is configured for the same checks; it has not run remotely yet. OpenAPI checking currently validates YAML, operation-ID uniqueness and local references, not full response-schema conformance.

## Database and module workflow

Migrations 0001–0011 came from the earlier Waggle backend. Migration 0012 adds authentication market/delivery metadata. Applied SQL is immutable; add forward migrations. Countries, locales and phone delivery policy will expand through explicit configuration and reviewed migrations.

Each completed module gets relevant tests, contract/examples, updated docs/memory and a focused commit. No remote push or deployment has been performed. Next: consent and resumable onboarding, households and dog profiles; then media/verification, home/discovery, likes/connections, chat and notifications.
