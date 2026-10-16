# Waggle API

India-first dog social/matching backend built with TypeScript, Express and PostgreSQL. International rollout is part of the design.

## Plan and project memory

- [API plan](docs/API_PLAN.md): full user journey, endpoint inventory across 16 modules, data rules, implementation order and launch gates.
- [Research](docs/RESEARCH.md): dated primary sources and decisions drawn from them.
- [Implementation ledger](docs/IMPLEMENTATION.md): delivered modules, limitations and next work.
- [Project memory](PROJECT_MEMORY.md): user decisions, environment and future-session handoff.
- [OpenAPI](docs/openapi.yaml) and [HTTP examples](docs/requests.http): implemented endpoints only.
- [Frontend handovers and wire diagrams](docs/handovers/README.md): module status, integration contracts, errors and screen flows.
- [Dev and production deployment plan](docs/DEPLOYMENT_PLAN.md): proposed AWS environments, build/release flow, private image storage and the steps needed before launch.

The provisional launch scope is dog playdates/walks. Breeding introductions and owner dating have separate rollout plans. The founder's launch-mode clarification is still pending; common platform work is underway.

## Current status (10 October 2026)

171 documented HTTP operations across M01–M12, including connections, encrypted text chat/realtime, inbox, meetups, safety/support/privacy request tracking and staff operations. Home counters, waitlist and verified phone changes are included. **The app is not fully complete or production ready.** See [remaining work and required inputs](docs/REMAINING_WORK.md) and the [production boundary note](docs/PRODUCTION_READINESS.md). M13–M16 remain planned; account_data_v1 exports run through the encrypted export worker; erasure and external delivery remain incomplete.

## Local development

Requires Node 22+ and Docker. PostgreSQL uses port 5433 to coexist with other projects.

```sh
npm ci
npm run setup:dev
docker compose up -d postgres
npm run migrate:dev
npm run dev
```

`setup:dev` creates/updates the ignored `.env.development`, generates a local authentication secret if absent and explicitly enables development OTP delivery. `npm run dev`, `npm run start:dev` and `npm run migrate:dev` load that file explicitly. For local sign-in, request OTP for `+919000000001` and enter `000000`; the normal request, expiry, attempt and single-use rules still apply. Other numbers and privacy/phone-change purposes receive random codes printed to the local server terminal. **No SMS is sent, and this fixed test pair proves no phone ownership.** Authentication is disabled by default without the opt-in. The development sender cannot run in production. A production SMS adapter and DLT registration are still required.

Run `npm run setup:prod-env` once to create the ignored `.env.production` from [.env.production.example](.env.production.example). It deliberately has no database URL or secrets, so `npm run start:prod` and `npm run migrate:prod` fail until real production values are supplied. Hosted production should inject these values from its secret manager instead of copying an env file into the image. The legacy `.env` is no longer loaded by application code or the environment-specific commands.

If port 3000 is already occupied, stop your previous Waggle process or set `PORT` in `.env.development`. Redis is available in Compose on 6380 but is not yet used by these modules.

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
| Private photos | Upload, status, order, deletion and local cleanup; see below |
| Verification/health | Request/status/withdrawal and self-reported health records; see below |

Bootstrap example: `/v1/app/bootstrap?platform=android&buildNumber=1&countryCode=IN&locale=en-IN`. India is marked `development`; unbuilt product features remain disabled. Published store links, reviewed legal documents and public rollout are pending. Staff can edit the stored release policy; product routes enforce a confirmed minimum build once it exceeds 1. Area administration only supports nonpublic India states.

OTP signup and returning-user login share one flow. New accounts require a name and remain `pending`; live onboarding readiness is tracked separately from account status. Access JWTs last 15 minutes; refresh families last 30 days. Serialize refresh calls on the client: reusing a rotated refresh token revokes its whole family. Logout/device revocation takes effect on subsequent authenticated requests. Profile edits cannot change verification, roles or account status.

Phone resend/attempt limits are persisted in PostgreSQL. IP limits are currently per process; shared rate limiting and a production SMS provider remain launch requirements. This is a development milestone, not a production-ready app.

City operations staff can list India areas at `GET /admin/v1/areas` and edit their nonpublic rollout state at `PATCH /admin/v1/areas/{id}` with an expected version and reason code. The route cannot open an area publicly; see [M01 handover](docs/handovers/M01.md) for the contract and readiness effects.

## Checks

```sh
npm run typecheck
npm run build
npm test
npm run check:openapi
npm run check:handovers

# Create once; tests clear fixture data in this dedicated test database.
docker exec dogdating-api-postgres createdb -U waggle waggle_api_test
TEST_DATABASE_URL=postgres://waggle:waggle@localhost:5433/waggle_api_test npm run test:integration
```

Integration tests refuse databases whose names do not end in `_test`. They verify migrations twice, authentication, consent/onboarding, household permissions, concurrent owner changes, dog validation and publication using real PostgreSQL. GitHub Actions is configured for the same checks; it has not run remotely yet. OpenAPI checking currently validates YAML, operation-ID uniqueness and local references, not full response-schema conformance.

## Database and module workflow

Migrations 0001–0011 came from the earlier Waggle backend. Migration 0012 adds authentication market/delivery metadata; 0013 adds consent/onboarding; 0014 adds invitations and dog drafts; 0015 adds photo uploads; 0016 adds verification intake and health-record deletion metadata; 0017 adds manual location state; 0018 adds publisher-bound discovery eligibility and feed sessions. Applied SQL is immutable; add forward migrations. Countries, locales and phone delivery policy will expand through explicit configuration and reviewed migrations.

Each completed module gets relevant tests, contract/examples, updated docs/memory and a focused commit. No remote push or deployment has been performed. Next work is tracked in docs/REMAINING_WORK.md; production media/moderation and verification remain launch dependencies.

## Consent and onboarding

`GET /v1/me/onboarding` returns saved preferences, the selected dog, missing prerequisites and a next action. Save the adult self-declaration with `PUT /v1/me/onboarding/preferences`; it does not grant an identity or age-verification badge. Select a dog with `PUT /v1/me/active-dog` and `{ "dogId": "..." }` (or null to clear).

`GET/POST /v1/me/consents` reads/accepts document versions; `DELETE /v1/me/consents/{purpose}` records withdrawal. `GET /v1/legal/documents/{kind}` serves published, immutable text, optionally by version. **No legal text is seeded.** Until reviewed documents, approved photos, location and guardian verification exist, completion returns 409 and progress explains what is missing. Tests use labeled synthetic evidence in the test database only.

`GET/PATCH /v1/me/preferences` controls discovery pause and read receipts. Discovery cannot be enabled with incomplete onboarding. Clients must use the current `ready`/`missing` fields: historical `completedAt` alone is insufficient after evidence expires or a policy changes. Photo uploads and verification intake are available below; moderation approval and verified grants remain external prerequisites; manual city selection is implemented.

## Households and dog profiles

Create/list households at `/v1/households`; read/rename one at `/v1/households/{id}`. The creator becomes the accepted owner in the same transaction. Members have `owner`, `co_guardian`, `walker`, or `view_only` roles. Owners manage membership through `GET /members` and `PATCH/DELETE /members/{userId}` under the household path. The final owner cannot be removed or demoted, including during concurrent requests.

`POST /v1/households/{id}/invitations` creates a seven-day phone-bound token. The owner shares it manually; no invitation SMS is sent. The signed-in intended recipient calls `POST /v1/household-invitations/{token}/accept`. Only the token hash is stored, consumed/expired tokens cannot be reused, and the inviter must still be an owner. Treat tokens as secrets and keep them out of access logs.

Create/list dog drafts at `/v1/dogs`; household members can read `/v1/dogs/{id}`, and owners/co-guardians can edit it. `PUT /breeds`, `/temperament`, `/preferences`, and `/availability` under that path save the dog's profile and matching inputs. Breed percentages must total 100; client-submitted breed evidence is always `declared`. Temperament version 1 currently accepts structured self-reported dimensions; the original twelve-question scoring UI is not implemented.

`POST /publish`, `/pause`, `/memorialise`, and `POST/DELETE /beacon` manage visibility and walking-now status. Publishing requires this dog to be selected and its guardian's live onboarding checks to pass. A beacon also requires discovery enabled and lasts at most 90 minutes. Memorialisation is owner-only and cannot be reversed with profile edits. Editing core profile details returns a published dog to draft; identity or breed changes revoke existing dog-verification grants so stale claims cannot survive edits.

Household/dog lists use `limit` (default 20, maximum 50) and a user/list-scoped `nextCursor`, ordered by UUID. `GET /v1/dogs/{id}` is a private household view; discovery profiles now have a separate impression-scoped route; dog transfers and precise GPS capture are still pending. Publication is a stored lifecycle state, not proof that future discovery safety/consent checks may be skipped.

## Private photo uploads

Opt in locally with `MEDIA_MODE=local` in `.env.development` when photo testing resumes. Files go to ignored `.local/media-development`, or `MEDIA_LOCAL_DIR`. Local storage is forbidden in production and must never be exposed as static content.

1. `POST /v1/dogs/{dogId}/media/uploads` with `contentType` (`image/jpeg` or `image/png`), `sizeBytes` and lowercase SHA-256 of the original bytes.
2. Send those bytes to the returned `PUT /v1/media/{id}/content` path using the uploader's bearer token and exact content type. The reservation lasts 15 minutes; content can be submitted once. On a lost response, read status before retrying.
3. `POST /v1/media/{id}/complete` with `{}` is idempotent. Completion records a durable **pending** moderation item; it does not approve the photo.

Inputs are capped at 8 MiB and 20 megapixels, decoded and re-encoded as JPEG up to 1600×1600 with EXIF/GPS removed. Originals are not stored. There are 30 live slots per dog and 60 reservations per dog/day. Only owners/co-guardians can edit; sending bytes also requires the original uploader. Membership is checked on each call.

Use `GET /v1/dogs/{dogId}/media`, `GET /v1/media/{id}`, `PATCH /v1/dogs/{dogId}/media/order` (`mediaIds`: every live photo exactly once), and `DELETE /v1/dogs/{dogId}/media/{id}`. Responses contain metadata only; no photo download endpoint is enabled. Deletion resets dog publication and cancels its beacon.

Run `npm run media:cleanup` regularly while using local uploads. Each run handles up to 100 expired reservations or pending deletions and can safely be repeated. Storage failures retain a cleanup flag; a failed delete may already have hidden the photo. Production object storage, scanning/moderation workers, approved-photo delivery and automated scheduling remain upcoming integrations.

## Verification intake and health records

`POST /v1/verifications` accepts `{ "kind": "guardian" }` for the signed-in user or `{ "kind": "dog", "dogId": "..." }` for an owned/co-guarded dog. The server selects the target tier (1 or 2). Retries return the same active request; at most three new requests per user/day are allowed. Read it at `GET /v1/verifications/{id}` and withdraw an open request with `POST /v1/verifications/{id}/withdraw` and `{}`. Requests are private to their requester; dog requests also require current household membership.

`POST /webhooks/verification` is a provider-only boundary. An injected verifier must authenticate the exact raw body, timestamp and source before a normalized result can be applied. Matching event replays are acknowledged; conflicting IDs are rejected. Approval grants a time-limited tier only after current request, account and dog ownership checks. **The normal server has no verifier configured and returns 503**, so no local or production client can use this route to claim an approved identity. A disposable test signer exercises it only in the test database. The provider's real callback format, evidence policy and credentials are still required.

**Provider integration is not configured:** new requests return `pending` with `nextAction: awaiting_provider_setup`. This records intent only. No provider session, review SLA, verified badge, identity-document upload or webhook is available yet. Do not submit identity numbers/documents as profile photos.

`POST/GET /v1/dogs/{dogId}/health-records` stores/lists private health metadata. Create with `recordType`, `testedAt`, optional `expiresAt`, and optional `resultCode`. Dates must be real, tests cannot predate birth or lie in the future, and expiry cannot predate the test. New records always have `provenance: self_reported` and no verification date; they never grant health badges. Lists use the standard `limit`/`cursor` pagination and explicitly mark expired records. Limits: 100 live records per dog and 10 creations per dog/day.

Owners/co-guardians can `DELETE /v1/dogs/{dogId}/health-records/{id}`. Removal is idempotent and hides the record from household lists; retained database evidence follows the future retention/deletion policy. Removing reviewed evidence revokes dog health tiers (3+) and resets publication. Actual reviewer/provider integrations and document handling are still pending.

## Mobile/web handovers and wire diagrams

Start at [docs/handovers/README.md](docs/handovers/README.md). All 16 modules have a handover with implemented/planned status, screen flow and wireframe. Implemented modules include endpoint/access/status tables, request/response shapes, examples, error codes and client recovery rules. [Shared client conventions](docs/handovers/COMMON.md) cover authentication, pagination, errors and development setup.

Run `npm run docs:handovers` after changing OpenAPI or module guidance; `npm run check:handovers` detects stale handovers and runs in CI. Authored guidance lives in `scripts/handover-notes.mjs`.

## Consented manual location

`GET /v1/app/areas?countryCode=IN&query=Bengaluru` lists coarse selectable/development/waitlist areas with standard `limit`/`cursor` pagination. Bengaluru remains development seed data; the list is not a public-launch promise.

After accepting the current location policy, an owner/co-guardian can `PUT /v1/households/{id}/location` with `{ "source": "manual_area", "areaId": "..." }`. Household members can GET that path. The response reports `precision: city`, area details, `updatedAt` and `canChangeAt`; it contains no coordinates or matching cells. Manual selection stores only the city identifier. GPS capture and displaced anchors remain planned.

Identical saves are idempotent; a different selection is allowed once per 24 hours. `DELETE` clears location immediately while retaining the change deadline, so deleting/recreating cannot bypass the limit. Changing or clearing the area resets household dog publication and cancels beacons. Personal location-consent withdrawal and shared household location removal are separate actions. Onboarding checks live consent and area availability; a city-only location must never be presented as a precise distance in future discovery.

## Blocking

`POST /v1/me/blocks` with `{ "userId": "..." }` blocks another user idempotently (204). `GET /v1/me/blocks` lists only your outgoing blocks with standard pagination; `DELETE /v1/me/blocks/{userId}` removes your block idempotently. The other direction remains effective. Existing active cross-household matches are blocked and conversations close; unblocking does not restore them. Shared household membership is not removed. Maximum 500 outgoing blocks. See the [safety handover](docs/handovers/M11.md).

## Home and development discovery

`GET /v1/home` returns the selected dog, live onboarding tasks and discovery availability. Connections, messages, meetup and notification sections explicitly return `not_implemented` with null values until those modules exist.

Discovery is off by default. `DISCOVERY_MODE=development` with `AUTH_SECRET` enables the development metadata feed; this mode cannot run in production. It does not enable bootstrap's public product flags. Eligible test evidence belongs only in the dedicated test database; do not fabricate verification or legal content in development accounts to bypass missing providers.

- `GET /v1/feed?dogId=...&mode=pack&limit=20&cursor=...`
- `GET /v1/feed/empty-reason?dogId=...`
- `GET /v1/dogs/{targetId}/profile?dogId={actorId}&impressionToken=...`
- `GET /v1/dogs/{id}/discovery-preferences`

Use `PUT /v1/dogs/{id}/preferences` with `allowCityOnly: true` to explicitly opt into the whole city. Both dogs need this preference. Distance is unknown; kilometre buckets cannot be enforced from a manual city selection. Cards include approved-photo metadata, with `mediaDelivery: unavailable`; image delivery remains pending.

Discovery additionally requires an active account with verified adulthood, current guardian evidence and consent, an eligible published dog, and current editor membership. This is stricter than merely saving an adult declaration or reaching onboarding readiness. Publishing now records the consenting publisher; legacy published dogs must be republished before becoming eligible. These checks, bilateral household blocks and matching preferences are evaluated on every feed/profile read.

Ranking uses energy similarity, shared play styles, size and overlapping same-timezone schedules. Signed ten-minute snapshots contain up to 200 IDs; pages recheck current privacy and preserve snapshot order. Changed actor settings require restarting. A card's impression token is bound to caller, actor, target and mode; it cannot authorize a stale/ineligible profile. Redact query tokens from request logs.

Limits are persisted: 60 new feed snapshots/hour/user and 200 distinct exposed dogs per UTC day. Run `npm run discovery:cleanup` regularly to remove sessions older than a day and prior-day exposure records. No scheduler is configured yet. See [M06 handover](docs/handovers/M06.md) for response shapes, reasons, recovery and wireframes.

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

Provider-neutral push relay now has durable leases, per-installation receipts, timeout/backoff, invalid-token handling, live permission/preference checks, quiet-hour deferral and dead-letter state. Staff operations can inspect/retry jobs. Migration 0030. An FCM HTTP v1 adapter can be run manually with `npm run push:deliver` after setting `FCM_PROJECT_ID`, Google Application Default Credentials and the development `MESSAGE_KEY`; it sends only generic notification metadata. No Firebase credentials, scheduler or production key wrapper are configured. APNs/Web Push adapters remain absent, and `pushAvailable` remains false.

Meetup reminder/expiry pass: `npm run meetups:reminders` (requires external scheduling). See [M10 handover](docs/handovers/M10.md).

Staff `reviewer` role now has an audited, exclusive meetup incident queue. See [M12 handover](docs/handovers/M12.md).

Staff operations can browse bounded, redacted audit metadata through `GET /admin/v1/audit-events`.

Run one bounded operations pass with `npm run maintenance:run`. Schedule it externally for timely meetup reminders and cleanup; media cleanup and encrypted exports have separate commands. Overlapping passes return `already_running`.

Run `npm run verification:expire` for a standalone bounded tier-expiry sweep; the maintenance pass includes it. No verification is granted without reviewed evidence.

Operations staff can inspect the latest maintenance pass through `GET /admin/v1/jobs`; a stale `running` state needs an operator check.

Guardians can track their own private meetup incident reviews through `/v1/me/incident-reviews`, including with a restricted safety token after a block or suspension.

Reviewed support guidance can be drafted and published by provisioned legal operations staff, then read from `/v1/help/articles`. No article text is seeded.

When staff raise a confirmed minimum app build above 1, product calls require `X-App-Platform` and `X-App-Build`; obsolete builds receive `426 update-required`. Bootstrap and safety/account recovery routes stay reachable.
