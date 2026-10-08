import { pool } from '../../db/pool.js';
import { transaction } from '../../db/transaction.js';
try { console.log(await transaction(pool,async tx=>{
  const sessions=await tx.query("DELETE FROM graph.discovery_sessions WHERE created_at<now()-interval '1 day'");
  const reads=await tx.query("DELETE FROM graph.discovery_profile_reads WHERE day<(now() AT TIME ZONE 'UTC')::date");
  return {sessions:sessions.rowCount,reads:reads.rowCount};
})); }finally{await pool.end();}
