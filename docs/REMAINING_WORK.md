# Remaining work and launch dependencies

Updated 10 October 2026. The checked-in backend has 169 documented HTTP operations. The product is **not fully complete or ready for public launch**. Implemented foundations and unavailable integrations are distinguished in the [implementation ledger](IMPLEMENTATION.md), [module handovers](handovers/README.md) and [production boundary note](PRODUCTION_READINESS.md).

## Required integration inputs

| Input | Why it is needed | Current behavior |
| --- | --- | --- |
| Production SMS provider and India DLT sender/templates | Real OTP delivery, delivery callbacks and shared throttling | Opt-in terminal-only development OTP |
| Object storage, moderation/scan service and key management | Private object delivery, approved photos, encrypted production chat/cases and deletion | Local adapters forbidden in production; no approved image delivery |
| Guardian/dog verification provider and evidence policy | Verified adulthood/identity, vendor-specific callback authentication, reviewer grants and account activation | Provider-neutral callback, replay ledger and atomic grant transitions exist; no real verifier installed, so callbacks return 503 and no production badge or activation is available |
| Push credentials/provider | FCM/APNs/Web Push delivery, invalid registration handling and retry worker | Durable inbox works; push jobs wait for provider |
| Staff OIDC issuer/JWKS/audience and approved staff subjects | Real SSO/MFA and role provisioning | Admin routes unavailable without trusted identity configuration |
| Reviewed legal/support content and retention/hold policy | Publish current documents, provide support contacts, process exports/erasure/vendor/backup retention | No legal text seeded; privacy requests remain needs_review |
| Launch city, store IDs/URLs, supported locales and support staffing | Public rollout, obtainable mandatory updates, place review and incident handling | India/Bengaluru development configuration only |
| Billing/store products and provider | Verified receipts, webhooks, subscriptions/refunds and entitlement lifecycle | Free persisted quotas only; purchases unavailable |

No credentials, provider selection, legal approval or operational response is inferred from a request to implement backend features.

## Remaining backend work

| Module | Remaining scope |
| --- | --- |
| M01 | Country administration and waitlist outbound delivery. Audited release edits, legal-version hints and conditional API update enforcement are implemented |
| M02 | Production SMS/DLT, distributed abuse controls and broader security audit/monitoring; optional OAuth/passkeys/recovery factors |
| M04 | GPS/displaced anchors and twelve-question scoring; structured temperament, city-only location and two-party dog transfers already work |
| M05 | Production uploads/delivery, scan/moderation, document uploads, selected provider's raw signature/timestamp adapter, reviewer evidence policy and account activation; provider-neutral callback/replay ledger and expiry sweep are implemented |
| M06 | Production discovery rollout, precise-distance matching and external scheduling of the bounded snapshot cleanup; account-wide home counters are implemented |
| M08 | Production key wrapping/rotation, moderated attachments, typing/presence/shared read receipts, scalable event delivery; expired tickets are cleaned after one day, and current sockets use bounded DB polling |
| M09 | Vendor adapter/credentials and operational scheduling; provider-neutral relay, receipts/backoff, invalid-token handling, quiet hours and dead-letter operations are implemented |
| M10 | Reviewer response workflow and external scheduling for the implemented two-party extensions/reminders/expiry pass; optional groups/video |
| M11 | Broader legal-response exports (photo files/shared/provider categories) and full erasure pipeline, shared-household ownership handling, vendor/search/cache/backup deletion, scoped holds and reviewed help article content and external deletion page; own meetup incident tracking and publishing workflow are implemented |
| M12 | Verification review/provider evidence, reviewed audit retention, external maintenance scheduling, broader privacy job execution and operational metrics; report and meetup incident decisions support dismiss/escalate, with suspension handled separately |
| M13 | Store offerings, verified receipt/restore, subscription/cancellation/refund/grace rules, signed billing webhooks and referral/growth behavior |
| M14 | Additional market configuration, local content/providers, quota-zone rules and reviewed residency/rollout policy |
| M15 | Optional breeding mode requires explicit product approval and reviewed jurisdiction/evidence rules before implementation/enablement |
| M16 | Optional human dating and live safety require explicit product approval, isolated privacy design and real response capability |

## Suggested next implementation sequence

1. Choose SMS, storage/KMS, moderation and verification providers; implement their authenticated adapters and callbacks with provider test environments.
2. Complete broader export/erasure processing against the reviewed retention policy and shared-household rules; requests must never be marked completed while data remains unprocessed.
3. Wire the push provider and schedule the existing maintenance/media/export/push workers. Incident-review tooling is implemented, but requires real staffing.
4. Finish legal/release administration, rollout checks and production verification.
5. Implement approved growth/expansion modes only after their product and provider contracts are decided.

No provider integration, public rollout, remote push or deployment was performed in the implementation session.
