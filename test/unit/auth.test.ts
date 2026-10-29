import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DevelopmentOtpSender, LOCAL_TEST_OTP_CODE } from '../../src/modules/auth/otp-sender.js';
import { requestOtpSchema } from '../../src/modules/auth/auth.schemas.js';

test('local OTP adapter refuses production and test environments', () => {
  assert.throws(() => new DevelopmentOtpSender('production'));
  assert.throws(() => new DevelopmentOtpSender('test'));
});

test('fixed development code works for sign-in numbers and never for sensitive OTP purposes', () => {
  const sender = new DevelopmentOtpSender('development');
  assert.equal(sender.fixedCodeFor('+919000000001', 'auth'), LOCAL_TEST_OTP_CODE);
  assert.equal(sender.fixedCodeFor('+919000000002', 'auth'), LOCAL_TEST_OTP_CODE);
  assert.equal(sender.fixedCodeFor('+919000000001', 'privacy'), undefined);
  assert.equal(sender.fixedCodeFor('+919000000001', 'phone_change'), undefined);
});

test('launch enrollment validates country and phone independently', () => {
  assert.equal(requestOtpSchema.safeParse({ phoneE164: '+919000100000', countryCode: 'IN' }).success, true);
  assert.equal(requestOtpSchema.safeParse({ phoneE164: '+919000100000', countryCode: 'US' }).success, false);
  assert.equal(requestOtpSchema.safeParse({ phoneE164: '+911234567890' }).success, false);
  assert.equal(requestOtpSchema.safeParse({ phoneE164: '+14155551234' }).success, false);
});
