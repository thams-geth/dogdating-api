import { pool } from '../../db/pool.js';
import { processVerificationExpiry } from './expiry-worker.js';
try{console.log(JSON.stringify(await processVerificationExpiry(pool)));}
catch{console.error('Verification expiry pass failed. Retry the scheduled job.');process.exitCode=1;}
finally{await pool.end();}
