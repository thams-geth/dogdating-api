export interface OtpSender {
  send(phoneE164: string, code: string): Promise<void>;
}

/** Explicit local-only adapter. Never enabled implicitly or used in production. */
export class DevelopmentOtpSender implements OtpSender {
  constructor(environment: string) {
    if (environment !== 'development') throw new Error('Development SMS sender requires NODE_ENV=development');
  }
  async send(phoneE164: string, code: string): Promise<void> {
    process.stdout.write(`[LOCAL SMS ONLY] phone ending ${phoneE164.slice(-4)} code ${code}\n`);
  }
}
