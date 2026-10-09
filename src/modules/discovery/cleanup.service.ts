import type { Pool } from 'pg';
import { transaction } from '../../db/transaction.js';

// Keep recent snapshots long enough for rate accounting and support investigation.
export async function cleanupDiscovery(db:Pool,limit=1000){
 const batch=Math.max(1,Math.min(limit,1000));
 return transaction(db,async tx=>{
  const sessions=await tx.query(`DELETE FROM graph.discovery_sessions WHERE id IN (
   SELECT id FROM graph.discovery_sessions WHERE created_at<now()-interval '1 day' ORDER BY created_at,id LIMIT $1
  )`,[batch]);
  const reads=await tx.query(`DELETE FROM graph.discovery_profile_reads WHERE ctid IN (
   SELECT ctid FROM graph.discovery_profile_reads WHERE day<(now() AT TIME ZONE 'UTC')::date LIMIT $1
  )`,[batch]);
  return {sessions:sessions.rowCount??0,reads:reads.rowCount??0};
 });
}
