import { GoogleAuth } from 'google-auth-library';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { LocalMessageCipher } from '../messages/message-cipher.js';
import { FcmPushProvider } from './fcm-provider.js';
import { deliverPushBatch } from './push-worker.js';

try {
  if (!config.FCM_PROJECT_ID || !config.MESSAGE_KEY) throw new Error('FCM project and development message key are required.');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  const cipher = new LocalMessageCipher(config.MESSAGE_KEY, config.NODE_ENV);
  const provider = new FcmPushProvider(config.FCM_PROJECT_ID, () => auth.getAccessToken());
  console.log(JSON.stringify(await deliverPushBatch(pool, cipher, provider)));
} catch {
  console.error('Push delivery pass unavailable or failed. Check FCM project, ADC credentials and local message key.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
