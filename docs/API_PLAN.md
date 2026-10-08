# Waggle API plan

Plan version: 1.0 • 7 October 2026 • Backend: TypeScript + Express + PostgreSQL.

## 1. Product and release boundaries

Build an India-first dog social and matching app, with country expansion designed into the data model. A user is a guardian; a household owns one or more dogs; matching operates on a selected dog. Guardians can manage multiple dogs. A mutual like creates a connection and conversation, not an obligation to meet.

**Provisional launch assumption:** dog playdates, walks and friendships (Pack). Breeding introductions (Lineage) and dating between owners (Spark) have distinct gates and later releases. The founder has been asked to confirm this. Shared work on app configuration, auth, profiles and ownership can proceed while that answer is pending.

Start in one Indian metro; the existing Bengaluru seed is development data, not a confirmed launch decision. The plan covers the whole product, but launch requires the modules marked L. G means growth after launch, X means country expansion, and F means a separately approved future surface.

## 2. User journey and screen mapping

| Journey/screen | API responsibility | Exit / recovery |
| --- | --- | --- |
| Splash / app update | Bootstrap, maintenance, supported country, minimum/latest builds | Supported app proceeds; update screen has store link; support and deletion remain accessible |
| Welcome / signup / login | Country + phone OTP, attempts, resend delay, sessions | One OTP flow signs in existing accounts or creates a draft account; no password duplication |
| Guardian profile | Name, adult policy, language, timezone, notices and consents | Draft progress survives restart; private phone/DOB never enter dog discovery |
| Household / add dog | Ownership, dog profile, breed mix, photo uploads | Multiple dogs supported; draft can be edited before publishing |
| Health / temperament | Structured answers, vaccination evidence, guardian verification | Self-reported, pending and verified claims visibly differ |
| Location / preferences | Separate location consent, coarse matching anchor, availability | Manual supported-area choice or waitlist when permission is refused; no hidden GPS requirement |
| Onboarding completion | Server computes missing required fields and next action | Skipping a UI screen never bypasses a server requirement |
| Home | Active dog, profile tasks, connections/unread counts, upcoming meetup summary | Aggregated read model; detailed discovery has its own cursor |
| Discover | Filtered dog cards, coarse distance buckets, compatibility reasons | Clear empty reason: no area, filters, no local supply or temporary unavailability |
| Likes | Interest/pass, sent likes, eligible incoming likes, remaining quota | Idempotent retries; blocked/hidden/removed dogs cannot be liked |
| Connections | Mutual matches and unmatch | One conversation per active match; unmatch ends message permission |
| Messages | Conversation list/history, text send, receipts, reconnect | Durable client outbox and server deduplication; REST history repairs socket gaps |
| Plan a meetup | Propose/accept/counter/decline/cancel, public place, attendees | State changes notify participants; attendance and review follow |
| Notifications | Device registration, persistent inbox, preferences | Denied push permission never prevents use of the app |
| Settings / support | Privacy controls, block list, export, deletion, grievances | Tracked requests, clear progress and support escalation |

## 3. API conventions

- REST JSON under `/v1`; server field names camelCase; UUID identifiers; UTC ISO timestamps; ISO country/currency codes; IANA timezone; BCP 47 locales. Database columns remain snake_case.
- Distinguish `countryCode` (market), `phoneCallingCode`, `residencyRegion` (storage policy), locale and timezone. A +91 phone is not proof of current residence.
- Single-resource responses have their documented shape; collections use named arrays and `nextCursor` (new routes). Preserve existing `{ breeds }` and token shapes. The old Android client is a draft: explicitly document any changed fields before integrating it.
- Cursor pagination defaults to 20, caps at 50, and binds the last ordering key plus resource/filter scope. Chat supports `afterSeq` for resume and `beforeSeq` for older history, never both.
- Errors use `application/problem+json`: `type`, `code`, `title`, `status`, `detail`, `requestId`, optional field errors and retry information. Never echo OTPs, tokens, request bodies or database errors.
- 200 read/update; 201 created; 202 accepted asynchronous request; 204 delete/logout; 400 invalid payload; 401 missing/invalid session; 403 eligibility/permission; 404 missing or inaccessible private resource; 409 conflicting state/idempotency body; 413 too large; 429 quota/rate; 503 dependency/maintenance. Client compatibility error is 426 with `update-required`.
- `Authorization: Bearer` for user routes. Per-object checks remain mandatory after authentication. Separate staff authentication/roles for `/admin/v1`.
- `X-App-Platform` and `X-App-Build` describe client compatibility, not identity. Bootstrap is always reachable. An update gate must exempt auth logout, account deletion, report/support access and recovery paths as appropriate.
- `Idempotency-Key` is required for retryable product creates: decisions, message sends, meetup proposals and paid actions. Store a body hash, status and response with an expiry and principal/route scope. Atomic database uniqueness remains necessary even when a key is supplied.
- Webhooks verify the raw-body signature, timestamp and provider event ID; save the event before acknowledging. Never trust a mobile client to award a verified badge or subscription.
- Validation rejects unknown write properties; consent, verification, household role and subscription state cannot be mass assigned.
- No exact household coordinates or matching cells in public profiles, feed, logs or analytics. Use a reviewed frozen/displaced anchor and coarse distance buckets; original GPS, if needed for re-anchor detection, is encrypted and access restricted.

## 4. Endpoint inventory

Paths below are planned unless IMPLEMENTATION.md marks them complete. Each method/path pair is a separate operation even where grouped for readability. U = authenticated guardian, P = public, S = staff, W = signed provider. Roles and eligibility are additional checks.

### M01 — App lifecycle and reference data [L]

| Method + path | Access | Purpose / fields |
| --- | --- | --- |
| GET `/health`, `/ready` | P | Liveness; database and applied-schema readiness |
| GET `/app/bootstrap?platform=&buildNumber=&countryCode=&locale=` | P | Update policy, market availability, effective locale, feature availability, current policy versions |
| GET `/app/countries` | P | Supported markets, rollout state, language/currency/unit settings |
| GET `/dogs/breeds` | P | Canonical catalogue; no private user data |
| GET `/app/areas?countryCode=&query=` | P | Supported launch areas and waitlist state; no precise household counts |
| POST `/waitlist`; DELETE `/waitlist/{id}` | U | Opt in/out of a selected launch-area notification |
| GET `/legal/documents/{kind}?countryCode=&locale=&version=` | P | Published, reviewed terms/privacy/community text; immutable versions |

Bootstrap reports `none`, `recommended`, or `required` update based on numeric build comparisons per platform; an unknown/unopened country receives an unavailable-market result, never silently India. Features report actual rollout state. Never set a hard update before the build is obtainable in the target store/country. API flags are display hints; domain gates independently enforce permissions.

### M02 — Authentication and sessions [L]

| Method + path | Access | Purpose |
| --- | --- | --- |
| POST `/auth/otp/request` | P | `{phoneE164, countryCode}`; always generic 202 for valid allowed-market requests, even when phone is throttled |
| POST `/auth/otp/verify` | P | `{phoneE164, code, deviceId, displayName?}`; new account requires name; returns access/refresh pair and userId |
| POST `/auth/refresh` | P | Rotate refresh token; reuse invalidates family |
| POST `/auth/logout` | U | Revoke current session family |
| GET `/auth/sessions`; DELETE `/auth/sessions/{id}` | U | Own devices and remote revocation |
| POST `/auth/logout-all` | U | Revoke all own sessions |
| POST `/auth/phone-change/request`, `/auth/phone-change/verify` | U | Recent authentication plus ownership of new number; collision and audit checks |
| POST `/auth/oauth/{provider}` | P, G | Google/Apple verified token exchange and explicit account linking; never merge by unverified email |
| POST `/auth/passkeys/options`, `/auth/passkeys/verify` | U, G | Additional sign-in/recovery factor |

OTP: six random digits, 10-minute expiry, five failed attempts, 60-second resend gap and three sends per phone/hour; additional IP/device limits. HMAC OTPs and phone lookup keys; do not log them in production. An explicitly enabled local development sender may print codes for synthetic test users. All OTP attempts and refresh rotation are serialized. Increment failed attempts and commit before returning an error; throwing inside a transaction must not roll back a lockout or token-family revocation. Phone ownership is not adult or identity verification.

Access lasts 15 minutes, refresh 30 days with a fixed family lifetime. Check session revocation and account state on protected requests. Concurrent refreshes are serialized; clients use a single refresh coordinator. SMS production delivery and DLT onboarding are a release dependency.

### M03 — Guardian profile, consent and resumable onboarding [L]

| Method + path | Access | Purpose |
| --- | --- | --- |
| GET `/me`; PATCH `/me` | U | Private guardian profile; masked phone, name, locale/timezone; allowlisted edits |
| GET `/me/onboarding` | U | Required/completed steps, missing fields, active dog and next action |
| PUT `/me/onboarding/preferences` | U | Draft country/area, intended mode, adult declaration and language |
| POST `/me/onboarding/complete` | U | Recompute prerequisites; do not accept `completed=true` from client |
| GET `/me/consents`; POST `/me/consents`; DELETE `/me/consents/{purpose}` | U | Evidence: purpose/version/locale/time; optional consent withdrawal |
| PUT `/me/active-dog` | U | Owned and non-memorialised dog only |
| GET/PATCH `/me/preferences` | U | Visibility, notification privacy, read receipts, discovery pause |

States: `account_created → guardian_details → household → dog_details → media → temperament → area → verification → ready`. Individual steps may be saved out of order. Progress derives from domain records; versioned onboarding rules tell older accounts what has newly become required. Declining optional marketing/push consent does not prevent completion. Initial 18+ policy is a product decision, not a claim of age verification.

### M04 — Households and dog profiles [L]

| Method + path | Access | Purpose |
| --- | --- | --- |
| POST/GET `/households`; GET/PATCH `/households/{id}` | U | Create/list own households; membership-scoped detail/edit |
| POST `/households/{id}/invitations` | Owner | Invite by verified destination; expiring hashed invite token |
| POST `/household-invitations/{token}/accept` | U | Intended recipient verification and single-use acceptance |
| GET `/households/{id}/members` | Member | List guardians with limited fields |
| PATCH/DELETE `/households/{id}/members/{userId}` | Owner | Role change/removal; cannot orphan household |
| PUT `/households/{id}/location` | Owner/co-guardian | Consented location → private anchor; no GPS in response |
| POST/GET `/dogs`; GET/PATCH `/dogs/{id}` | Member | Draft/create/edit/list dogs belonging to household |
| PUT `/dogs/{id}/breeds` | Editor | Breed mix with percentage validation |
| PUT `/dogs/{id}/temperament`, `/preferences`, `/availability` | Editor | Validated structured questionnaires, filters and weekly schedule |
| POST `/dogs/{id}/publish`; POST `/dogs/{id}/pause` | Editor | Eligibility, approved media, required profile completeness |
| GET `/dogs/{id}/profile` | U | Authorized public projection, respects blocks and visibility |
| POST/DELETE `/dogs/{id}/beacon` | Editor | Walking-now TTL, at most 90 minutes; cancel supported |
| POST `/dogs/{id}/memorialise` | Owner | Remove from discovery and inappropriate notifications |
| POST `/dogs/{id}/transfer`; POST `/dog-transfers/{id}/accept` | Owner, G | Two-party ownership transfer preserving appropriate history |

Do not let a walker/view-only member edit health, ownership or profile data. Birth date vs estimated age is explicit. Species is dog only for launch. A neutral birth/health rule must not automatically label a dog medically safe.

### M05 — Uploads and verification [L]

| Method + path | Access | Purpose |
| --- | --- | --- |
| POST `/dogs/{id}/media/uploads` | Editor | MIME/size purpose; private short-lived signed upload + mediaId |
| POST `/media/{id}/complete`; GET `/media/{id}` | U | Verify actual object, type and checksum; queue processing/status |
| PATCH `/dogs/{id}/media/order`; DELETE `/dogs/{id}/media/{mediaId}` | Editor | Owned media and publish completeness checks |
| POST `/verifications`; GET `/verifications/{id}` | U | Guardian/dog verification session and actionable status |
| POST `/verifications/{id}/documents` | U | Private document upload |
| POST/GET `/dogs/{id}/health-records`; DELETE `/dogs/{id}/health-records/{id}` | Editor | Vaccination/health evidence; verification provenance |
| POST `/webhooks/verification`; POST `/webhooks/media` | W | Durable event ingestion, signature/replay checks |

Delivery status (8 October 2026): local private photo upload/status/order/delete and verification-intent/health-metadata APIs are implemented. Local content uses authenticated PUT rather than a signed object-store URL. Moderation, approved delivery, identity/document providers, webhooks and review grants remain planned; see IMPLEMENTATION.md.

Uploads remain quarantined until scan/moderation; strip EXIF, cap pixel counts, generate variants, clean abandoned objects. Document access is tightly scoped and audited. Self-reported health and provider/reviewer-verified health are different. Expiry removes the corresponding verified claim. Choose a vendor after checking India coverage, data handling, price and operating process.

### M06 — Home and discovery [L]

| Method + path | Access | Purpose |
| --- | --- | --- |
| GET `/home?dogId=` | U | Selected dog, tasks, unread counts, connections, next meetup; honest partial-section status |
| GET `/feed?dogId=&mode=pack&cursor=&limit=` | U | Coarse-area candidates, filters, ranked cards, signed impression tokens |
| GET `/feed/empty-reason?dogId=` | U | Specific actionable empty-state reasons |
| GET `/dogs/{id}/discovery-preferences` | Editor | Current effective filters and allowed ranges |

No arbitrary GPS/radius probe on the feed. Exclude self, household dogs, blocked/suspended/hidden dogs and disallowed candidates. Start with an explainable heuristic over temperament, size preferences, schedule and coarse distance. No ML service required initially. Signed impressions bind viewer, actor dog, target dog, mode and expiry; profile reads have distinct-profile limits. Home counters follow the same blocking rules as lists.

### M07 — Likes, connections and entitlements [L]

| Method + path | Access | Purpose |
| --- | --- | --- |
| POST `/decisions` | U | `{actorDogId,targetDogId,mode,verdict,impressionToken}`; interest/pass; quota and eligibility |
| GET `/likes/sent`; GET `/likes/received` | U | Actor-dog-scoped pending interests, cursor pagination and visibility checks |
| DELETE `/likes/{id}` | U | Withdraw own pending interest; no hidden resurrection of unmatched pairs |
| GET `/matches`; GET `/matches/{id}` | U | Mutual connections and their state/conversation |
| DELETE `/matches/{id}` | Participant | Immediate unmatch; close message permission |
| GET `/me/entitlements` | U | Server-computed capabilities, remaining quotas, reset time |

Plan default inherited from Waggle: unverified users may browse but cannot like/message; verified free users receive 12 interests per local day. Treat this as configurable product policy needing funnel validation. Incoming-like visibility must not promise a paid feature before billing exists. Canonical pair uniqueness plus row/advisory locks and transactions ensure reciprocal concurrent likes produce one match and one conversation; do not solve this solely with cache locks. A block overrides subscription or match state.

### M08 — Messages and realtime [L; attachments G]

| Method + path | Access | Purpose |
| --- | --- | --- |
| GET `/conversations` | Participant | Latest message preview, unread count, cursor |
| GET `/conversations/{id}/messages?beforeSeq=&afterSeq=&limit=` | Participant | Bounded history or reconnect recovery |
| POST `/conversations/{id}/messages` | Participant | `{clientMessageId,kind,body?,mediaId?}` with stable retry identity |
| POST `/conversations/{id}/read` | Participant | Monotonic `upToSeq`, bounded by existing messages |
| PATCH `/conversations/{id}/preferences` | Participant | Mute, archive, local visibility; does not delete other's history |
| POST `/conversations/{id}/report` | Participant | Report with authorized message references |
| POST `/realtime/tickets` | U | Short-lived single-use socket ticket; no reusable JWT in a logged URL |
| WS `/realtime` | Ticket | `message.created`, `message.ack`, `read.updated`, `typing`, `match.created`, `sync.required` |

Text first. Server assigns per-conversation sequence within the message transaction. Unique `(sender, conversation, clientMessageId)` deduplicates HTTP and socket retries. Check live membership and block state on every send/read/subscription. Persist before acknowledge; notifications/outbox after commit. Presence is coarse/opt-in, typing ephemeral and limited. Socket reconnect always has REST fallback. Attachments follow media moderation. Do not claim end-to-end encryption unless implemented and reviewed.

### M09 — Notifications and devices [L]

| Method + path | Access | Purpose |
| --- | --- | --- |
| PUT `/me/devices/{installationId}`; DELETE same | U | Provider registration, platform/locale/app build, revoke on logout |
| GET `/notifications`; POST `/notifications/read` | U | Durable inbox and bounded list of IDs to mark read |
| GET/PUT `/me/notification-preferences` | U | Categories/channels, previews, timezone and quiet hours |

Outbox drives match, message, meetup, moderation and verification updates. Retries have backoff, event deduplication and a dead-letter queue. Remove invalid registrations; transfer device ownership safely on account switch. Notification payloads avoid full messages, exact location and sensitive health/identity information. Delivery is best effort; durable inbox is authoritative.

### M10 — Meetups and places [L; groups/video G]

| Method + path | Access | Purpose |
| --- | --- | --- |
| GET `/places`; GET `/places/{id}`; POST `/places/suggestions` | U | Reviewed public dog-friendly locations and suggestions |
| POST/GET `/meetups`; GET `/meetups/{id}` | Participant | Proposed or scheduled meetings with selected owned dogs |
| POST `/meetups/{id}/respond`, `/cancel` | Participant | Accept/decline/counter with revision check; cancellation reason |
| POST `/meetups/{id}/check-in`, `/check-out`, `/extend` | Participant | Attendance timeline and reminder changes |
| POST `/meetups/{id}/reviews`; GET same | Participant | Structured review, private incident note and release timing |
| POST `/meetups/{id}/virtual-sniff` | Participant, G | Expiring video room token |
| POST `/groups`; POST `/groups/{id}/join-requests`; POST `/groups/{id}/join-requests/{id}/decide` | U, G | Capacity and organizer-controlled attendance |

States: proposed → accepted/countered/declined → completed/cancelled/expired. Review uniqueness per participant; reveal after both reviews or timeout. Concurrent accepts/counters use revision control. Block/unmatch cancellation policy must be explicit; users retain their own safety report path. First launch includes practical meeting guidance and incident reporting. Do not market an SOS/live-tracking service until separately staffed and tested.

### M11 — Trust, safety, privacy and support [L]

| Method + path | Access | Purpose |
| --- | --- | --- |
| POST/GET `/me/blocks`; DELETE `/me/blocks/{userId}` | U | Immediate cross-household discovery/contact suppression; unblock does not restore a match |
| POST `/reports`; GET `/reports/{id}` | U | Dog/user/media/message/meetup report; reporter identity private |
| GET `/me/safety-notices`; POST/GET `/me/appeals` | U | Enforcement explanations and review workflow |
| POST/GET `/support/tickets`; GET `/support/tickets/{id}`; POST `/support/tickets/{id}/messages` | U | Support and privacy grievances |
| POST `/me/data-exports`; GET `/me/data-exports/{id}` | U | Async export, short-lived download, recent reauthentication |
| POST `/me/deletion-requests`; GET `/me/deletion-requests/{id}` | U | Recent reauthentication, revoke discovery/sessions, tracked erasure |
| POST `/privacy/deletion/otp/request`, `/verify` | P | External deletion-page identity proof; restricted token, no account creation |
| GET `/help/articles?locale=` | P | Reviewed safety/support guidance and external deletion URL |

Deletion includes user rows, private media, messages as required by policy, vendor records, search/caches and backup expiry. Shared household dogs require transfer/remaining-owner rules. Legal holds are scoped, documented and excluded from normal access; communicate retained categories. Proposed operational target is completion within 30 days, subject to verified legal obligations; not a blanket statutory claim. Keep only necessary security/audit records under an explicit retention policy.

### M12 — Operations and staff [L]

Use `/admin/v1` (not `/v1/admin`) with staff SSO/MFA and role checks. Every sensitive read and action is audited.

| Methods + resource | Role | Purpose |
| --- | --- | --- |
| GET `/reports`; POST `/reports/{id}/claim`, `/decide` | Moderator | Queue ownership, evidence, reasons, escalation |
| GET `/verifications`; POST `/verifications/{id}/decide` | Reviewer | Manual evidence review, expiry and appeals |
| GET `/users/{id}`; POST `/users/{id}/actions` | Support/moderator | Minimal support projection, suspend/reinstate with reason |
| GET `/appeals`; POST `/appeals/{id}/decide` | Appeals | Different reviewer from original enforcement |
| GET/POST/PATCH `/places` and `/{id}` | City ops | Safe public-place registry |
| GET/PATCH `/countries/{code}`, `/app-releases/{platform}` | Release ops | Audit rollout/version changes; staged validation |
| GET `/jobs`, `/metrics`, `/audit-events` | Operations | Failed delivery/deletion, queue health, launch funnel |

Staff cannot retrieve raw household location or casually read private messages. Evidence access is case-scoped. Analytics initially covers onboarding funnel, eligible dogs by sufficiently large area, time to first match/conversation, meetup acceptance/completion, report resolution and crash/error rates. Never fabricate local supply counts.

### M13 — Billing and growth [G]

GET `/commerce/offerings`, POST `/commerce/receipts`, POST `/commerce/restore`, GET `/commerce/subscriptions`, POST `/commerce/cancel-intents`, signed POST `/webhooks/billing`. Provider-confirmed entitlements, renewal/cancellation/refund/grace-period rules and receipt replay protection are required. Start with one subscription only when product value is demonstrated. Digital subscriptions and any future animal-service payments have different policy reviews.

### M14 — Country expansion [X]

Country policy has: launch state; supported phone regions; residency region; default/supported locales; timezone suggestions; currency/minor units; distance display units; minimum age policy; feature availability; policy document versions; SMS/verification providers; support hours and country contacts. APIs continue accepting ISO identifiers and UTC instants. Quotas use IANA zones and handle DST; changing timezone must not mint extra daily quota.

Opening a country requires local privacy/consumer/breeding review, processor and transfer assessment, localized documents/content, compatible payment/store configuration, moderation/support capacity, tested phone delivery and enough dog/venue supply in the first city. Users traveling abroad do not automatically migrate residency. Existing accounts remain manageable from unopened countries; country restrictions apply to new enrollment/discovery availability, not deletion/support access.

### M15 — Breeding introductions [F]

GET/POST/PATCH `/lineage/breeders/me`; GET/POST/PATCH `/lineage/listings` and `/{id}`; GET/PUT `/lineage/pedigree/{dogId}`; POST `/lineage/coi/preview`; POST/GET `/lineage/enquiries`; POST `/lineage/outcomes`; GET `/lineage/verify-lookup`. Registration verification, breed-specific health evidence, provenance, ancestry cycle prevention, COI completeness and jurisdiction-specific eligibility are prerequisites. No puppy checkout, escrow or breeding payment custody in this plan. Existing inherited lineage tables are not proof of correct current legal rules.

### M16 — Optional human dating and live safety [F]

Human dating requires explicit product approval and separate consent/data access design before `/spark/*` endpoints. Precise live walk sharing, if approved, uses isolated short-lived storage and `/walk/sessions`, `/position`, `/revoke`, `/sos` with trusted-recipient access. No promised emergency dispatch or tracking service without a real operational response capability.

## 5. Storage and asynchronous work

| Area | Existing baseline | Add / review before module implementation |
| --- | --- | --- |
| Identity | users, sessions, OTP, households, members | Country distinct from residency, consents, onboarding state/version, invitations, device registrations |
| Graph | dogs, breeds, temperament, media, preferences | Profile publication rules, upload ownership/state, visibility and translation projections |
| Match/chat | decisions, matches, conversations, messages | Atomic reciprocity, durable client-message deduplication, receipts, retention and block predicates |
| Verification | requests and grants | Real provider events, document vault, human review, expiry jobs |
| Operations | outbox, audit, metros | App/country policy, idempotency records, distributed rate counters, worker leases/dead letters |
| Privacy/safety | reports, blocks, enforcement | Consent withdrawal effects, export/deletion receipts and grievances |

Migrations 0001–0011 are inherited and already applied locally. Add new migrations; never rewrite applied SQL. Audit each inherited table when its module is implemented, especially precise-location storage, auth transaction behavior, inherited legal claims and future-mode columns.

Scheduled work: OTP/session cleanup, failed-delivery retry, media cleanup/moderation, badge expiry, notification fan-out, meetup reminders, beacon expiry, review reveal, data export/deletion, idempotency expiry and aggregate analytics. Job execution must be restartable and safe under duplicate delivery.

## 6. Architecture and test strategy

One Express modular service: route/schema → service → repository. Controllers do no SQL. A composition root injects database/provider dependencies. PostgreSQL owns transactional state; Redis can support shared throttles/cache later; object storage owns media; worker consumes an outbox. No Kafka, Kubernetes, graph database or ML service needed for initial traffic. Use India-region hosting as our initial deployment choice, not a universal legal claim.

Each module delivers validated routes, migrations, OpenAPI definitions, examples, authorization and failure-path tests, README/status updates and one focused commit. Run typecheck/build plus relevant tests. Critical integration tests use a dedicated disposable PostgreSQL database, not development users. Test failed OTP attempts surviving rollback, refresh reuse, cross-user access, concurrent likes, message retries, blocks, expired verification, consent withdrawal and interrupted deletion. CI runs migrations against an empty database and a second no-op pass.

## 7. Implementation order and launch gate

1. M01 foundation/configuration and reference data.
2. M02 auth/sessions and private profile skeleton.
3. M03 consent/onboarding + M04 households/dogs.
4. M05 media/verification + M11 blocks/reports foundations.
5. M06 home/feed + M07 likes/connections.
6. M08 chat + M09 notifications.
7. M10 meetups + M11 complete privacy/support + M12 operations.
8. Staging/mobile integration, load/concurrency tests, restore/recovery drills, store readiness, controlled city beta.
9. M13 paid features, then M14 second country; M15/M16 only after their feature decisions.

Before public launch: complete the India user journey on a real device; actual OTP delivery; verified media pipeline; moderation/report/block response; working deletion in-app and via website; provider webhooks/reconciliation; truthful update policies/store links; private data absent from logs; backups restored in a drill; CI and staging green; monitoring/alerts and named operators; reviewed policy documents and launch-market obligations. Performance budgets and capacity tests must be based on measured traffic expectations, not inherited enterprise-scale estimates.
