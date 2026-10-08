import type { PoolClient } from 'pg';
import { ApiError } from '../../middleware/error.js';
import { householdsBlocked } from '../../db/social-lock.js';
export class ConnectionsRepository {
 async match(tx:PoolClient,userId:string,id:string,allowEnded=false){
  await tx.query(`SELECT h.id FROM identity.households h WHERE h.id IN (
   SELECT d.household_id FROM graph.dogs d JOIN meetup.matches m ON d.id IN (m.dog_a_id,m.dog_b_id) WHERE m.id=$1
  ) ORDER BY h.id FOR UPDATE`,[id]);
  const row=(await tx.query(`SELECT m.id,m.dog_a_id AS "dogAId",m.dog_b_id AS "dogBId",m.state,m.created_at AS "createdAt",
   c.id AS "conversationId",a.household_id AS ha,b.household_id AS hb,a.status AS sa,b.status AS sb,
   a.deleted_at AS da,b.deleted_at AS db
   FROM meetup.matches m JOIN graph.dogs a ON a.id=m.dog_a_id JOIN graph.dogs b ON b.id=m.dog_b_id
   JOIN meetup.conversations c ON c.match_id=m.id JOIN meetup.conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$2
   WHERE m.id=$1 AND NOT EXISTS(SELECT 1 FROM identity.households hidden WHERE hidden.id IN (a.household_id,b.household_id) AND hidden.deleted_at IS NOT NULL) AND EXISTS(SELECT 1 FROM identity.household_members member JOIN identity.households h ON h.id=member.household_id
    WHERE member.user_id=$2 AND member.accepted_at IS NOT NULL AND member.role IN ('owner','co_guardian') AND h.deleted_at IS NULL
     AND member.household_id IN (a.household_id,b.household_id))`,[id,userId])).rows[0];
  if(!row || row.da || row.db || row.sa!=='active'||row.sb!=='active'||await householdsBlocked(tx,row.ha,row.hb))throw new ApiError(404,'not-found','Connection is unavailable.');
  if(!allowEnded&&row.state!=='active')throw new ApiError(404,'not-found','Connection is unavailable.');
  return row;
 }
 projection(row:Record<string,unknown>){return {id:row.id,dogAId:row.dogAId,dogBId:row.dogBId,state:row.state,conversationId:row.state==='active'?row.conversationId:null,createdAt:row.createdAt};}
}
