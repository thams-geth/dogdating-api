import type { Pool } from 'pg';
import { cleanupDiscovery } from '../discovery/cleanup.service.js';
import { processVerificationExpiry } from '../verification/expiry-worker.js';
import { processMeetupReminders } from '../meetups/reminder-worker.js';

// A single pass for jobs whose expiry semantics are already defined. The
// advisory session lock prevents overlap across workers using this database.
export async function runMaintenance(db:Pool){
 const lock=await db.connect();let held=false;
 try{
  held=(await lock.query('SELECT pg_try_advisory_lock($1) AS acquired',[70419002])).rows[0].acquired;
  if(!held)return {status:'already_running' as const};
  // These partitions support audited writes near month boundaries. Retention
  // deletion requires a reviewed policy and is deliberately separate.
  await db.query("SELECT ops.create_audit_partition(now()::date),ops.create_audit_partition((now()+interval '1 month')::date)");
  const discovery=await cleanupDiscovery(db);
  const ephemeral=await db.query(`WITH tickets AS (
   DELETE FROM meetup.realtime_tickets WHERE expires_at<now()-interval '1 day' RETURNING 1
  ), tokens AS (
   DELETE FROM identity.privacy_tokens WHERE expires_at<now()-interval '1 day' RETURNING 1
  ) SELECT (SELECT count(*)::int FROM tickets) AS tickets,(SELECT count(*)::int FROM tokens) AS tokens`);
  const verification=await processVerificationExpiry(db);
  const meetups=await processMeetupReminders(db);
  return {status:'completed' as const,discovery,ephemeral:ephemeral.rows[0],verification,meetups};
 }finally{
  try{if(held)await lock.query('SELECT pg_advisory_unlock($1)',[70419002]);}
  finally{lock.release();}
 }
}
