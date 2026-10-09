import { randomUUID } from 'node:crypto';
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
  const runId=randomUUID();
  await lock.query("INSERT INTO ops.maintenance_status(singleton,run_id,status,started_at,finished_at,summary,last_error_code) VALUES(true,$1,'running',now(),NULL,NULL,NULL) ON CONFLICT(singleton) DO UPDATE SET run_id=$1,status='running',started_at=now(),finished_at=NULL,summary=NULL,last_error_code=NULL",[runId]);
  try{
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
   const summary={discovery,ephemeral:ephemeral.rows[0],verification,meetups};
   await lock.query("UPDATE ops.maintenance_status SET status='completed',finished_at=now(),summary=$2,last_error_code=NULL WHERE singleton AND run_id=$1",[runId,summary]);
   return {status:'completed' as const,runId,...summary};
  }catch(error){
   await lock.query("UPDATE ops.maintenance_status SET status='failed',finished_at=now(),summary=NULL,last_error_code='maintenance_failed' WHERE singleton AND run_id=$1",[runId]).catch(()=>undefined);
   throw error;
  }
 }finally{
  try{if(held)await lock.query('SELECT pg_advisory_unlock($1)',[70419002]);}
  finally{lock.release();}
 }
}
