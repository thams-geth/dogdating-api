import type { Pool } from 'pg';
import { transaction } from '../../db/transaction.js';
import { socialLock } from '../../db/social-lock.js';

// Expiry is a one-way safety transition. A new grant needs a separate reviewed
// provider/reviewer workflow and cannot be created by this worker.
export async function processVerificationExpiry(db:Pool,limit=100){
 let revoked=0,guardians=0;
 for(let i=0;i<Math.max(0,Math.min(limit,100));i++){
  const result=await transaction(db,async tx=>{
   await socialLock(tx);
   const row=(await tx.query(`SELECT subject_type,subject_id,tier FROM verify.tiers_granted
    WHERE revoked_at IS NULL AND expires_at<=now() ORDER BY expires_at,subject_type,subject_id,tier
    LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
   if(!row)return null;
   await tx.query(`UPDATE verify.tiers_granted SET revoked_at=now(),revoked_reason='expired'
    WHERE subject_type=$1 AND subject_id=$2 AND tier=$3 AND revoked_at IS NULL`,[row.subject_type,row.subject_id,row.tier]);
   if(row.subject_type==='user'){
    const updated=await tx.query(`UPDATE identity.users u SET is_adult_verified=false,updated_at=now()
     WHERE u.id=$1 AND u.is_adult_verified AND NOT EXISTS(
      SELECT 1 FROM verify.tiers_granted t WHERE t.subject_type='user' AND t.subject_id=u.id
       AND t.tier>=1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()))`,[row.subject_id]);
    if(updated.rowCount){
     const dogs=(await tx.query(`UPDATE graph.dogs SET publication_state='paused',updated_at=now()
      WHERE published_by=$1 AND publication_state='published' RETURNING id`,[row.subject_id])).rows.map(r=>r.id);
     if(dogs.length)await tx.query('DELETE FROM graph.dog_availability WHERE dog_id=ANY($1::uuid[]) AND beacon_until IS NOT NULL',[dogs]);
    }
    await tx.query("INSERT INTO ops.audit_log(actor_kind,action,subject_type,subject_id) VALUES('system','verification.expired','user',$1)",[row.subject_id]);
    return updated.rowCount?'guardian':'grant';
   }
   await tx.query("INSERT INTO ops.audit_log(actor_kind,action,subject_type,subject_id) VALUES('system','verification.expired',$1,$2)",[row.subject_type,row.subject_id]);
   return 'grant';
  });
  if(!result)break;
  revoked++;if(result==='guardian')guardians++;
 }
 return {revoked,guardians};
}
