import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '../../db/transaction.js';
import { socialLock } from '../../db/social-lock.js';
import { ConnectionsRepository } from '../connections/connections.repository.js';
import { ApiError } from '../../middleware/error.js';
import { notifyConversation } from '../notifications/notifications.events.js';

// Run from an external scheduler. All work and its receipt commit together.
export async function processMeetupReminders(db:Pool,limit=50){
 const connections=new ConnectionsRepository();let expired=0,reminded=0;
 for(let i=0;i<limit;i++){
  const result=await transaction(db,async tx=>{
   await socialLock(tx);
   const due=(await tx.query(`SELECT m.id,m.match_id,m.state,c.id AS conversation_id
    FROM meetup.meetups m JOIN meetup.conversations c ON c.match_id=m.match_id
    WHERE (m.state='proposed' AND m.window_start<=now())
       OR (m.state='accepted' AND m.window_start>now() AND m.window_start<=now()+interval '15 minutes'
           AND NOT EXISTS (SELECT 1 FROM meetup.reminder_receipts r WHERE r.meetup_id=m.id))
    ORDER BY m.window_start,m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED`)).rows[0];
   if(!due)return null;
   if(due.state==='proposed'){
    await tx.query("UPDATE meetup.meetups SET state='cancelled',cancellation_reason='proposal_expired',revision=revision+1,updated_at=now() WHERE id=$1",[due.id]);
    return 'expired';
   }
   const participants=(await tx.query('SELECT p.user_id,p.dog_id FROM meetup.meetup_participants p WHERE p.meetup_id=$1',[due.id])).rows;
   if(participants.length!==2){await tx.query('INSERT INTO meetup.reminder_receipts(meetup_id) VALUES($1)',[due.id]);return 'suppressed';}
   try{
    for(const participant of participants){
     await connections.match(tx,participant.user_id,due.match_id);
     if(!(await tx.query(`SELECT 1 FROM graph.dogs d JOIN identity.household_members hm ON hm.household_id=d.household_id AND hm.user_id=$2 AND hm.accepted_at IS NOT NULL AND hm.role IN ('owner','co_guardian') WHERE d.id=$1`,[participant.dog_id,participant.user_id])).rowCount){await tx.query('INSERT INTO meetup.reminder_receipts(meetup_id) VALUES($1)',[due.id]);return 'suppressed';}
    }
   }catch(error){if(!(error instanceof ApiError))throw error;await tx.query('INSERT INTO meetup.reminder_receipts(meetup_id) VALUES($1)',[due.id]);return 'suppressed';}
   await tx.query('INSERT INTO meetup.reminder_receipts(meetup_id) VALUES($1)',[due.id]);
   await notifyConversation(tx,due.conversation_id,randomUUID(),'meetups',undefined,participants.map(p=>p.user_id));
   return 'reminded';
  });
  if(!result)break;
  if(result==='expired')expired++;else if(result==='reminded')reminded++;
 }
 return {expired,reminded};
}
