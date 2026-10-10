import type { PushProvider, PushResult } from './push-worker.js';

type TokenSource = () => Promise<string | null | undefined>;

function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(0, Math.ceil(seconds))) : 0;
}

function fcmErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) return;
  const error = body.error;
  if (!error || typeof error !== 'object' || !('details' in error) || !Array.isArray(error.details)) return;
  const detail = error.details.find((item: unknown) => item && typeof item === 'object' &&
    '@type' in item && item['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError');
  return detail && typeof detail.errorCode === 'string' ? detail.errorCode : undefined;
}

/** FCM HTTP v1 adapter. Credentials and scheduling are supplied by the caller. */
export class FcmPushProvider implements PushProvider {
  private readonly endpoint: string;
  constructor(projectId: string, private readonly tokenSource: TokenSource, private readonly fetcher: typeof fetch = fetch) {
    if (!/^[a-z][a-z0-9-]{5,99}$/.test(projectId)) throw new Error('Invalid FCM project ID.');
    this.endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  }
  supports(provider: string) { return provider === 'fcm'; }
  async send(input: Parameters<PushProvider['send']>[0]): Promise<PushResult> {
    if (!this.supports(input.provider)) return { status: 'permanent_failure' };
    if (input.signal.aborted) return { status: 'transient_failure' };
    try {
      const accessToken = await this.tokenSource();
      if (!accessToken || input.signal.aborted) return { status: 'transient_failure' };
      const response = await this.fetcher(this.endpoint, {
        method: 'POST', signal: input.signal,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: {
          token: input.token,
          notification: { title: input.payload.title },
          data: { notificationId: input.payload.notificationId, category: input.payload.category, deliveryId: input.deliveryId },
        } }),
      });
      if (response.ok) return { status: 'delivered' };
      const body: unknown = await response.json().catch(() => null);
      const code = fcmErrorCode(body);
      if (response.status === 404 && code === 'UNREGISTERED') return { status: 'invalid_token' };
      if (response.status === 408 || response.status === 429 || response.status >= 500 || response.status === 401) {
        return { status: 'transient_failure', retryAfterSeconds: Math.max(response.status === 429 ? 60 : 0, retryAfter(response.headers.get('retry-after'))) };
      }
      // INVALID_ARGUMENT may indicate our payload, so never delete a token for it.
      return { status: 'permanent_failure' };
    } catch {
      // Do not log the access token, registration token, provider body or exception.
      return { status: 'transient_failure' };
    }
  }
}
