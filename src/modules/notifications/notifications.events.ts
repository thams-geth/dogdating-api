import type { PoolClient } from 'pg';
// Durable inbox and pending delivery intent commit atomically with the source event.
export async function notifyConversation(tx:PoolClient,conversationId:string,eventId:string,category:'messages'|'connections'|'meetups',excludeUser?:string){
 const rows=(await tx.query(`INSERT INTO identity.notifications(user_id,event_id,category,conversation_id)
 SELECT cm.user_id,$2::uuid,$3::text,$1::uuid FROM meetup.conversation_members cm WHERE cm.conversation_id=$1 AND ($4::uuid IS NULL OR cm.user_id<>$4)
 ON CONFLICT(user_id,event_id) DO NOTHING RETURNING id`,[conversationId,eventId,category,excludeUser??null])).rows;
 for(const row of rows)await tx.query('INSERT INTO ops.push_jobs(notification_id) VALUES($1)',[row.id]);
}
