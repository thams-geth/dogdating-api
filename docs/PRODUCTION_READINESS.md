# Production integration boundary

Updated 10 October 2026. The backend has working development APIs, but no public production launch is enabled. See [remaining work](REMAINING_WORK.md) for missing providers and reviewed policy.

## Dummy data rule

Synthetic guardians, dogs, photos, verification events, legal text, store receipts and push responses may be used only in disposable integration tests or an explicitly isolated demo environment. They must be labeled as fixtures. The production server does not seed them or interpret them as evidence. A successful dummy flow proves our API state transitions, not a provider's identity check, image review, SMS delivery, purchase, or legal approval.

The local sign-in shortcut `+919000000001` / `000000` is available only through the development OTP sender after a fresh request. It never sends SMS or proves ownership of that phone number. Production startup rejects that sender; keep this test pair out of released clients and production account data. Photo integration and real SMS delivery are deferred for development at the user's request, but both remain public-launch blockers.

## Integration order

| Boundary | Safe backend work now | Production input still required |
| --- | --- | --- |
| Verification | Signed-event adapter interface, replay ledger, state transitions, fixture signer in tests | Chosen provider, actual signature format, evidence/assurance policy, test credentials |
| SMS | Existing durable phone/OTP limits and local sender | DLT registration, sender/template IDs, chosen transport and delivery receipts |
| Media | Private upload and image normalization | Object storage, scanner/moderator, approved delivery and key management |
| Push | Durable leased queue and FCM HTTP v1 adapter with test transport | Firebase project/ADC credentials, production key wrapping, scheduled worker and delivery monitoring; APNs/Web Push adapters if used |
| Exports/deletion | Encrypted scoped export and tracked erasure requests | Reviewed retention, legal hold, shared-household and vendor deletion rules |
| Billing | Free quotas only | Store products, receipt verification contract, webhook keys and refund rules |

No production adapter is enabled by installing this code. Provider callbacks must be verified over their raw request body by the selected adapter before any state change. Unknown or unconfigured adapters fail closed. Never put raw documents, Aadhaar numbers, OTPs, device tokens, or receipt secrets in logs or fixture files.

## Rollout checks

Before enabling a production mode, confirm provider contract and credentials, reviewed legal/support content, real staff provisioning, approved photo delivery, verified onboarding, worker scheduling/monitoring, store availability and the India launch city. Test credentials and synthetic fixtures must remain outside the production database. No deployment or public rollout is implied by this document.
