import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DevelopmentOtpSender } from '../../src/modules/auth/otp-sender.js';
import { requestOtpSchema } from '../../src/modules/auth/auth.schemas.js';

test('local OTP adapter refuses production and test environments', () => {
  assert.throws(() => new DevelopmentOtpSender('production'));
  assert.throws(() => new DevelopmentOtpSender('test'));
});

test('launch enrollment validates country and phone independently', () => {
  assert.equal(requestOtpSchema.safeParse({ phoneE164: '+919000100000', countryCode: 'IN' }).success, true);
  assert.equal(requestOtpSchema.safeParse({ phoneE164: '+919000100000', countryCode: 'US' }).success, false);
  assert.equal(requestOtpSchema.safeParse({ phoneE164: '+911234567890' }).success, false);
  assert.equal(requestOtpSchema.safeParse({ phoneE164: '+14155551234' }).success, false);
});
