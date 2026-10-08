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
| Consent and onboarding | Published legal documents, consent history/withdrawal, progress/completion, preferences and active dog; see below |
| Households | Creation, membership roles, invitations and acceptance; see below |
| Dog profiles | Drafts, breeds, temperament, matching preferences, availability and publication lifecycle; see below |

Bootstrap example: `/v1/app/bootstrap?platform=android&buildNumber=1&countryCode=IN&locale=en-IN`. India is marked `development`; unbuilt product features remain disabled. Published store links, reviewed legal documents, rollout administration and enforced minimum-build gates are pending. Release policy is currently reviewed code in `src/modules/app/policy.ts`.

OTP signup and returning-user login share one flow. New accounts require a name and remain `pending`; live onboarding readiness is tracked separately from account status. Access JWTs last 15 minutes; refresh families last 30 days. Serialize refresh calls on the client: reusing a rotated refresh token revokes its whole family. Logout/device revocation takes effect on subsequent authenticated requests. Profile edits cannot change verification, roles or account status.

Phone resend/attempt limits are persisted in PostgreSQL. IP limits are currently per process; shared rate limiting and a production SMS provider remain launch requirements. This is a development milestone, not a production-ready app.

## Checks

```sh
npm run typecheck
npm run build
npm test
npm run check:openapi

# Create once; tests clear fixture data in this dedicated test database.
docker exec dogdating-api-postgres createdb -U waggle waggle_api_test
TEST_DATABASE_URL=postgres://waggle:waggle@localhost:5433/waggle_api_test npm run test:integration
```

Integration tests refuse databases whose names do not end in `_test`. They verify migrations twice, authentication, consent/onboarding, household permissions, concurrent owner changes, dog validation and publication using real PostgreSQL. GitHub Actions is configured for the same checks; it has not run remotely yet. OpenAPI checking currently validates YAML, operation-ID uniqueness and local references, not full response-schema conformance.

## Database and module workflow

Migrations 0001–0011 came from the earlier Waggle backend. Migration 0012 adds authentication market/delivery metadata; 0013 adds consent/onboarding; 0014 adds invitations and dog drafts. Applied SQL is immutable; add forward migrations. Countries, locales and phone delivery policy will expand through explicit configuration and reviewed migrations.

Each completed module gets relevant tests, contract/examples, updated docs/memory and a focused commit. No remote push or deployment has been performed. Next: media/verification and private location capture, then home/discovery, likes/connections, chat and notifications.

## Consent and onboarding

`GET /v1/me/onboarding` returns saved preferences, the selected dog, missing prerequisites and a next action. Save the adult self-declaration with `PUT /v1/me/onboarding/preferences`; it does not grant an identity or age-verification badge. Select a dog with `PUT /v1/me/active-dog` and `{ "dogId": "..." }` (or null to clear).

`GET/POST /v1/me/consents` reads/accepts document versions; `DELETE /v1/me/consents/{purpose}` records withdrawal. `GET /v1/legal/documents/{kind}` serves published, immutable text, optionally by version. **No legal text is seeded.** Until reviewed documents, approved photos, location and guardian verification exist, completion returns 409 and progress explains what is missing. Tests use labeled synthetic evidence in the test database only.

`GET/PATCH /v1/me/preferences` controls discovery pause and read receipts. Discovery cannot be enabled with incomplete onboarding. Clients must use the current `ready`/`missing` fields: historical `completedAt` alone is insufficient after evidence expires or a policy changes. Media, verification and location-collection APIs are still upcoming modules.

## Households and dog profiles

Create/list households at `/v1/households`; read/rename one at `/v1/households/{id}`. The creator becomes the accepted owner in the same transaction. Members have `owner`, `co_guardian`, `walker`, or `view_only` roles. Owners manage membership through `GET /members` and `PATCH/DELETE /members/{userId}` under the household path. The final owner cannot be removed or demoted, including during concurrent requests.

`POST /v1/households/{id}/invitations` creates a seven-day phone-bound token. The owner shares it manually; no invitation SMS is sent. The signed-in intended recipient calls `POST /v1/household-invitations/{token}/accept`. Only the token hash is stored, consumed/expired tokens cannot be reused, and the inviter must still be an owner. Treat tokens as secrets and keep them out of access logs.

Create/list dog drafts at `/v1/dogs`; household members can read `/v1/dogs/{id}`, and owners/co-guardians can edit it. `PUT /breeds`, `/temperament`, `/preferences`, and `/availability` under that path save the dog's profile and matching inputs. Breed percentages must total 100; client-submitted breed evidence is always `declared`. Temperament version 1 currently accepts structured self-reported dimensions; the original twelve-question scoring UI is not implemented.

`POST /publish`, `/pause`, `/memorialise`, and `POST/DELETE /beacon` manage visibility and walking-now status. Publishing requires this dog to be selected and its guardian's live onboarding checks to pass. A beacon also requires discovery enabled and lasts at most 90 minutes. Memorialisation is owner-only and cannot be reversed with profile edits. Editing core profile details returns a published dog to draft; identity or breed changes revoke existing dog-verification grants so stale claims cannot survive edits.

Household/dog lists use `limit` (default 20, maximum 50) and a user/list-scoped `nextCursor`, ordered by UUID. `GET /v1/dogs/{id}` is a private household view; public discovery profiles, dog transfers and household location capture are still pending. Publication is a stored lifecycle state, not proof that future discovery safety/consent checks may be skipped.
