# Waggle app and API flows

Updated 29 October 2026. This is the quickest way to understand how the Waggle app, API modules, database and external services fit together.

Waggle is an India-first dog social and matching app. A guardian signs in, creates a household and dog profile, completes onboarding, discovers eligible dogs, expresses interest, matches, chats and can arrange a meetup. The current product scope is dog friendship, walks and playdates. Billing, country expansion, breeding introductions and owner dating remain planned.

## 1. System at a glance

```mermaid
flowchart LR
  subgraph Clients
    Android["Android app"]
    Web["Future web app"]
    StaffUI["React staff console<br/>dogdating-admin"]
  end

  subgraph API["Express API - TypeScript"]
    Public["Public routes<br/>bootstrap, help, OTP"]
    User["Guardian routes<br/>/v1"]
    Admin["Staff routes<br/>/admin/v1"]
    Realtime["WebSocket realtime"]
    Workers["CLI/background workers"]
  end

  Postgres[("PostgreSQL<br/>source of truth")]
  S3[("Private S3<br/>processed dog photos")]
  FCM["Firebase Cloud Messaging"]
  Identity["Staff OIDC provider"]
  Verify["Future verification provider"]

  Android --> Public
  Android --> User
  Android --> Realtime
  Web --> Public
  Web --> User
  StaffUI --> Admin
  Public --> Postgres
  User --> Postgres
  Admin --> Postgres
  Realtime --> Postgres
  Workers --> Postgres
  User --> S3
  Workers --> S3
  Workers --> FCM
  Admin --> Identity
  Verify -. "signed callback boundary" .-> API
```

PostgreSQL is authoritative for accounts, permissions, dogs, matches, messages and workflow state. S3 contains processed image bytes only; PostgreSQL stores the object key and metadata. Clients never receive AWS credentials.

## 2. Core data ownership

```mermaid
erDiagram
  USER ||--o{ SESSION : signs_in_with
  USER ||--o{ HOUSEHOLD_MEMBER : joins
  HOUSEHOLD ||--o{ HOUSEHOLD_MEMBER : contains
  HOUSEHOLD ||--o{ DOG : owns
  DOG ||--o{ DOG_MEDIA : has
  DOG ||--o{ HEALTH_RECORD : has
  DOG ||--o{ DECISION : makes
  DECISION }o--|| DOG : targets
  DOG ||--o{ MATCH : participates
  MATCH ||--|| CONVERSATION : creates
  CONVERSATION ||--o{ MESSAGE : contains
  MATCH ||--o{ MEETUP : plans
  USER ||--o{ NOTIFICATION : receives
  USER ||--o{ REPORT : submits
```

The important permission chain is:

```text
signed-in user → accepted household membership → role → dog/resource permission
```

An `owner` or `co_guardian` can edit a dog. A `walker` or `view_only` member has narrower access. Every request rechecks current membership, blocks and account state; possession of an ID never grants access.

## 3. Full app journey

```mermaid
flowchart TD
  Start["Open app"] --> Bootstrap["M01 Bootstrap, country and app update"]
  Bootstrap --> Supported{"Country/build allowed?"}
  Supported -->|No| Exit["Update, waitlist or help"]
  Supported -->|Yes| OTP["M02 Request and verify OTP"]
  OTP --> Profile["M03 Guardian profile and policies"]
  Profile --> Household["M04 Create household"]
  Household --> Dog["M04 Create dog draft"]
  Dog --> Details["Breed, temperament, preferences, availability"]
  Details --> Photos["M05 Upload private photos"]
  Photos --> Location["M04 Select consented city"]
  Location --> Verification["M05 Guardian/dog verification intake"]
  Verification --> Ready{"Server onboarding ready?"}
  Ready -->|No| Missing["Return missing steps / unavailable provider"]
  Missing --> Ready
  Ready -->|Yes| Publish["Publish dog and enable city-only discovery"]
  Publish --> Feed["M06 Home and discovery"]
  Feed --> Like["M07 Interest or pass"]
  Like --> Mutual{"Mutual interest?"}
  Mutual -->|No| Feed
  Mutual -->|Yes| Match["Match + conversation created atomically"]
  Match --> Chat["M08 Messages and realtime"]
  Chat --> Meetup["M10 Propose and manage meetup"]
  Meetup --> Review["Attendance, review and safety flows"]
```

Onboarding readiness is computed by the server from stored records. A client cannot skip requirements by sending a completion flag.

## 4. Login and session flow

```mermaid
sequenceDiagram
  participant App
  participant API
  participant DB as PostgreSQL
  participant SMS as SMS provider / dev sender

  App->>API: POST /v1/auth/otp/request
  API->>DB: Create hashed, expiring challenge
  API->>SMS: Deliver OTP
  API-->>App: 202 accepted
  App->>API: POST /v1/auth/otp/verify
  API->>DB: Lock challenge and check attempts/expiry
  API->>DB: Create user if new; create session
  API-->>App: Access token + rotating refresh token
  App->>API: Protected request with Bearer token
  API->>DB: Recheck session and account status
  API-->>App: Authorized response
```

In the explicitly configured development environment, any valid currently supported Indian phone number uses `000000` for normal sign-in after requesting a challenge. This lets testers create separate accounts. Expiry, one-use, resend and attempt limits still apply. Privacy and phone-change OTPs remain random. Production cannot enable the development sender.

Access tokens last 15 minutes. Refresh tokens rotate and belong to a 30-day family. Reusing an already rotated refresh token revokes the family.

## 5. Dog profile and onboarding flow

```mermaid
flowchart LR
  User["Guardian"] --> HH["Household"]
  HH --> Members["Owner / co-guardian / walker / viewer"]
  HH --> Dog["Dog draft"]
  Dog --> Core["Name, age, sex, size"]
  Dog --> Breed["Breed composition"]
  Dog --> Temperament["Temperament"]
  Dog --> Schedule["Availability"]
  Dog --> Preferences["Discovery preferences"]
  Dog --> Media["Photos"]
  HH --> Area["Consented manual city"]
  Core --> Gate{"Readiness gate"}
  Breed --> Gate
  Temperament --> Gate
  Schedule --> Gate
  Preferences --> Gate
  Media --> Gate
  Area --> Gate
  Gate -->|Ready and eligible| Published["Published dog"]
  Gate -->|Missing / expired| Draft["Draft + next action"]
```

Profile edits that invalidate eligibility reset publication. Consent withdrawal, account restrictions, expired evidence, removed membership and blocks are enforced live.

## 6. Photo and S3 flow

```mermaid
sequenceDiagram
  participant App
  participant API
  participant DB as PostgreSQL
  participant Image as Sharp processor
  participant S3 as Private S3 bucket

  App->>API: POST /v1/dogs/{dogId}/media/uploads
  API->>DB: Reserve media ID and expected hash/size/type
  API-->>App: Authenticated PUT path
  App->>API: PUT /v1/media/{id}/content (raw JPEG/PNG)
  API->>API: Verify owner, uploader, expiry, hash and size
  API->>Image: Decode, rotate, resize, strip metadata
  Image-->>API: Processed JPEG
  API->>S3: Put photos/{uuid}.jpg using ECS task role
  API->>DB: Mark uploaded and store dimensions
  App->>API: POST /v1/media/{id}/complete
  API->>S3: Confirm object exists
  API->>DB: Mark completed, moderation pending
  API-->>App: Private status metadata
```

The API currently receives the original bytes so it can validate and rewrite the image before S3 persistence. The bucket remains private. Approved-photo delivery and moderation are still pending, so clients receive status metadata rather than a public image URL.

## 7. Discovery, likes and matching

```mermaid
sequenceDiagram
  participant App
  participant API
  participant DB as PostgreSQL

  App->>API: GET /v1/feed?dogId=...
  API->>DB: Recheck actor eligibility, consent and area
  API->>DB: Filter blocks, household dogs, preferences and exposure limits
  API-->>App: Cards + signed impression tokens
  App->>API: POST /v1/decisions (interest/pass + token)
  API->>DB: Validate token and live eligibility
  API->>DB: Persist decision and daily quota
  alt Reciprocal interest exists
    API->>DB: Create one match and one conversation atomically
    API->>DB: Queue inbox/notification events
    API-->>App: Match created
  else No reciprocal interest
    API-->>App: Decision recorded
  end
```

Discovery is currently city-only development behavior. It does not calculate or expose exact distance. Feed tokens authorize a decision for a specific viewer, actor dog and target dog for a short time; they never bypass live privacy checks.

## 8. Messaging and notifications

```mermaid
flowchart LR
  Send["POST message with clientMessageId"] --> Check["Live match, member and block checks"]
  Check --> Persist["Encrypt and persist with sequence"]
  Persist --> Ack["Return durable acknowledgement"]
  Persist --> Inbox["Create recipient inbox event"]
  Inbox --> Queue["Push delivery job"]
  Queue --> Worker["FCM worker"]
  Worker --> Device["Generic push notification"]
  Persist --> Socket["Realtime poll/socket event"]
  Socket --> Receiver["Recipient app"]
  Receiver --> Recovery["REST history repairs gaps"]
```

REST history is authoritative. WebSockets use a one-use short-lived ticket and provide development realtime delivery. Message bodies are encrypted at rest with the configured development key; the implementation does not claim end-to-end encryption. Production key management remains pending.

## 9. Meetup flow

```mermaid
stateDiagram-v2
  [*] --> Proposed
  Proposed --> Accepted: accept
  Proposed --> Countered: counter
  Countered --> Accepted: accept revision
  Proposed --> Declined: decline
  Countered --> Declined: decline
  Accepted --> Cancelled: cancel/block/unmatch
  Accepted --> InProgress: check in
  InProgress --> Completed: check out / expiry pass
  Completed --> Reviewed: submit review
  Declined --> [*]
  Cancelled --> [*]
  Reviewed --> [*]
```

Meetups use reviewed public places, revision checks and recorded participants. Blocks and unmatches cancel active meetups. Reminders and expiry processing require an externally scheduled worker.

## 10. Safety, privacy and staff operations

```mermaid
flowchart TD
  Incident["Report, support request or meetup incident"] --> Case["Durable private case"]
  Case --> Queue["Role-scoped staff queue"]
  Staff["Staff OIDC + recent MFA"] --> Queue
  Queue --> Claim["Exclusive claim"]
  Claim --> Review["Redacted evidence / private notes"]
  Review --> Decision["Dismiss, escalate or account action"]
  Decision --> Audit[("Append-only audit metadata")]
  Decision --> Notice["User-visible status/notice when allowed"]

  User["Guardian"] --> Export["Account export request"]
  Export --> ExportWorker["Encrypted export worker"]
  User --> Delete["Deletion request"]
  Delete --> Restrict["Immediate session revocation and visibility pause"]
  Restrict --> Manual["Needs reviewed erasure process"]
```

Staff APIs use a separate identity system and roles. Ordinary user JWTs cannot call `/admin/v1`. Account export has a scoped implementation; full legal erasure and retention processing remain pending.

The sibling `../dogdating-admin` React application now provides the staff shell, operations dashboard, role-scoped queues, audit browser, exact user-ID lookup and release overview. Development accepts a short-lived OIDC bearer token in session storage. Production sign-in redirect still requires the selected identity provider, Authorization Code + PKCE and hosted configuration.

## 11. Background and scheduled work

| Command | Responsibility | Deployment status |
| --- | --- | --- |
| `node dist/db/migrate.js` | Apply immutable SQL migrations under an advisory lock | Run once before each service release |
| `npm run media:cleanup` | Remove expired/abandoned photo objects | Implemented; scheduler pending |
| `npm run discovery:cleanup` | Remove expired discovery snapshots/exposure rows | Implemented; scheduler pending |
| `npm run push:deliver` | Lease and deliver FCM jobs | Adapter implemented; credentials/scheduler pending |
| `npm run privacy:exports` | Build scoped encrypted account exports | Implemented; scheduler pending |
| `npm run meetup:reminders` | Send reminders and expire meetup state | Implemented; scheduler pending |
| `npm run maintenance:run` | Run bounded maintenance under one advisory lock | Implemented; scheduler pending |
| `npm run verification:expire` | Revoke expired verification grants | Implemented; scheduler pending |

In AWS these should run as separate one-off or scheduled ECS tasks using the same immutable image and appropriate IAM/database permissions.

## 12. API module map

| Module | Main route families | State |
| --- | --- | --- |
| M01 App lifecycle | `/v1/health`, `/v1/ready`, `/v1/app/*`, `/v1/help/*`, `/v1/waitlist` | Implemented foundation |
| M02 Authentication | `/v1/auth/*` | Development OTP and sessions implemented; production SMS pending |
| M03 Onboarding | `/v1/me`, `/v1/me/onboarding*`, `/v1/me/consents*`, `/v1/me/preferences` | Implemented |
| M04 Households/dogs | `/v1/households*`, `/v1/dogs*`, `/v1/dog-transfers*` | Implemented foundation |
| M05 Media/verification | `/v1/media*`, dog media/health routes, `/v1/verifications*`, provider webhook | Private S3 persistence implemented; moderation/providers pending |
| M06 Discovery | `/v1/home`, `/v1/feed*`, discovery profiles/preferences | Development city-only flow implemented |
| M07 Connections | `/v1/decisions`, `/v1/likes*`, `/v1/matches*`, entitlements | Implemented |
| M08 Messaging | `/v1/conversations*`, `/v1/realtime/tickets`, WebSocket `/v1/realtime` | Development text/realtime implemented |
| M09 Notifications | notification preferences, devices, inbox | Durable inbox and FCM relay implemented; hosted provider setup pending |
| M10 Meetups | `/v1/places*`, `/v1/meetups*` | Two-party flow implemented |
| M11 Safety/privacy | blocks, reports, support, appeals, exports, deletion, incidents | Foundations implemented; full erasure pending |
| M12 Staff operations | `/admin/v1/*` | Role-scoped operations implemented; real IdP/staffing pending |
| M13-M16 | Billing, expansion and optional future modes | Not implemented |

## 13. AWS development deployment

```mermaid
flowchart LR
  GitHub["GitHub branch"] --> Build["Docker build + tests"]
  Build --> ECR["Private ECR image"]
  ECR --> Migrate["One-off ECS migration task"]
  ECR --> Service["ECS Fargate API service"]
  Internet --> ALB["HTTPS Application Load Balancer"]
  ALB --> Service
  Service --> RDS[("Private RDS PostgreSQL")]
  Service --> S3[("waggle-dev-media-123456789012")]
  Secrets["Secrets Manager"] --> Service
  Service --> Logs["CloudWatch logs"]
  Scheduler["EventBridge Scheduler"] --> Workers["Scheduled ECS tasks"]
  Workers --> RDS
  Workers --> S3
```

Use `/v1/health` for process liveness and `/v1/ready` for database/schema readiness. Run migrations before updating the service. The S3 adapter uses the ECS task role; AWS access keys must never be stored in the app or environment files.

## 14. Where to read next

1. [Implementation ledger](IMPLEMENTATION.md) for delivered versus pending behavior.
2. [OpenAPI contract](openapi.yaml) for exact request and response schemas.
3. [Mobile/web handovers](handovers/README.md) for each module’s errors, examples, client behavior and wireframe.
4. [Runnable requests](requests.http) for manual API calls.
5. [Production readiness](PRODUCTION_READINESS.md) for launch blockers.
6. [Remaining work](REMAINING_WORK.md) for provider and operational dependencies.
7. [Deployment plan](DEPLOYMENT_PLAN.md) for AWS environment design.

The OpenAPI contract and module handovers are the client integration authority. This document explains how those contracts work together.
