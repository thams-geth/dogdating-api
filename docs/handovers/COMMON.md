# Shared mobile/web integration conventions

[Module index and wire diagram](README.md) · [OpenAPI](../openapi.yaml) · [HTTP examples](../requests.http)

## Environment and status

The local API base URL is `http://localhost:3000`. On an Android emulator, use your emulator's host-machine address (commonly `10.0.2.2`) rather than the emulator's own localhost. Physical devices need a reachable development host. No staging/production URL is configured here. Browser CORS configuration is not yet implemented; use a same-origin development proxy for a web client.

Backend setup is in the root [README](../../README.md). Local OTP is explicitly enabled with `npm run setup:dev` and printed in the server terminal for synthetic numbers. Photo storage is separately enabled with `MEDIA_MODE=local`. No real SMS, moderation or identity-verification provider is connected. Reviewed policy documents are not seeded. Coordinate reviewed content and provider setup with the backend developer; do not bypass missing prerequisites in the client.

OpenAPI documents implemented operations. API_PLAN.md includes future operations and is not a callable contract. Every module handover states its status. Wireframes show screen/content relationships, not finished UI specifications. All clocks, timestamps, IDs and example people/dogs in examples are illustrative.

## HTTP contract

- Prefix `/v1`. Send `Content-Type: application/json` for JSON bodies; raw photo upload uses `image/jpeg` or `image/png` with the original bytes.
- Protected routes require `Authorization: Bearer <accessToken>`. Public routes are marked explicitly. An object may still be inaccessible despite valid authentication.
- Field names use camelCase. UUIDs identify resources. Timestamps are UTC ISO strings; date-only values use `YYYY-MM-DD`. Use IANA timezones and ISO country codes exactly as documented.
- Responses have endpoint-specific shapes: no universal `data` wrapper. A 204 response has no JSON body. Do not call a JSON decoder on it.
- Writes reject unknown properties. Do not submit an entire GET response as a PATCH body. Never submit roles, verification, moderation or account status through profile inputs.
- Omitted, null and empty are distinct. Follow the type shapes and OpenAPI. Shape notation `?` means optional; null is only accepted where explicitly listed. `{}` requests should send an empty JSON object.
- Store server IDs from successful responses. Example UUIDs are not pre-created resources, except the documented development area seed.
- GET responses may change as membership, policy, verification or area rollout changes. Refetch after writes and app resume; avoid retaining a stale authorization decision.
- There is no universal `Idempotency-Key` implementation yet. Use the endpoint-specific retry rules; do not assume all POST/PUT operations can be replayed safely.

## Pagination

Households, dogs, areas and health records accept `limit` (default 20, maximum 50) and opaque `cursor`. Responses return a named array and `nextCursor` (null at the end). Send that token unchanged. Cursors are scoped to their list/user/filter; reset them after changing filters or accounts. UUID ordering is stable traversal, not newest-first ordering. Discovery uses its own signed, ten-minute snapshot cursor (up to 2048 characters); restart it after actor settings change or token expiry. Other lists such as breeds, consent purposes, photo slots and device sessions do not use this contract unless their endpoint says so.

## Errors

Content type: `application/problem+json`.

```json
{
  "type": "urn:waggle:problem:validation-failed",
  "code": "validation-failed",
  "title": "validation-failed",
  "status": 400,
  "detail": "Request validation failed.",
  "requestId": "77777777-7777-4777-8777-777777777777",
  "errors": [{ "path": "name", "code": "too_small" }]
}
```

`errors` is present for schema validation only. Paths can include dotted array indexes. Branch on stable top-level `code`; use `errors[].path` to highlight fields. `detail` is not a localization key and should not drive logic. Preserve `requestId` (also in `X-Request-Id`) for support without logging tokens, OTPs, private bodies or photo bytes.

| HTTP | Code | Client behavior |
| --- | --- | --- |
| 400 | `validation-failed` | Correct field input; unknown write fields also cause this error. |
| 400 | `invalid-json` | Fix JSON serialization. |
| 400 | `invalid-cursor` | Restart the list with unchanged intended filters and no cursor. |
| 401 | `unauthenticated` | Supply a bearer token or sign in. |
| 401 | `invalid-session` | Use one refresh coordinator where appropriate; failed refresh requires sign-in. |
| 403 | `forbidden` | Refresh membership and disable the unavailable action. |
| 404 | `not-found` | Treat as missing/inaccessible; do not reveal whether another account owns it. |
| 413 | `payload-too-large` | Reduce the request. JSON limit is 64 KiB; photo upload limit is 8 MiB. |
| 429 | `rate-limited` | Slow down. Do not assume every quota error supplies a Retry-After header. |
| 500 | `internal-error` | Show retry/support state with requestId. Re-read state before replaying a mutation. |
| 503 | `auth-unavailable` | Backend authentication is not configured. |
| 503 | `not-ready` | Readiness dependency/schema unavailable; retry with backoff. |

Module handovers add domain errors, including 409 state conflicts, 410 expired uploads and 415 unsupported photo content. There is no standard `retryAfter` JSON field. For location throttling specifically, read `canChangeAt` from GET household location.

## Loading, empty, unavailable and success states

Keep these distinct in every screen:

1. Loading: retain safe prior state while fetching, and disable duplicate mutations.
2. Empty: a successful empty collection is not an error or permission bypass.
3. Unavailable: no reviewed legal document/provider or a disabled rollout needs a clear explanation.
4. Validation/conflict: retain user input and allow correction/refetch.
5. Success: refresh the domain object and relevant onboarding progress.
6. Permission/session loss: stop protected reads/actions and clear the old account's cached data.

Photo completion is not moderation approval. A pending verification request is not verified identity. A historical onboarding completion is not current readiness. A published dog row is not permission to show it through a public feed.

## Client acceptance checklist

- Exercise slow requests, lost responses and duplicate taps without creating duplicate actions.
- Coordinate refresh across all concurrent API calls.
- Handle 204 without attempting JSON parsing.
- Use exact documented role/consent gates and refetch on membership revocation.
- Show development, pending, expired, unconfigured and unavailable states truthfully.
- Keep planned features hidden from public clients until their contracts and rollout exist.
- Verify critical workflows against the running backend; generated shapes do not replace response-schema integration tests.
