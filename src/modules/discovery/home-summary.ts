import type { PoolClient } from 'pg';
export async function homeSummary(tx:PoolClient,userId:string,messagesAvailable:boolean){
 const row=(await tx.query(`WITH visible AS (
 SELECT m.id,c.id AS conversation_id,cm.last_read_seq FROM meetup.matches m
 JOIN meetup.conversations c ON c.match_id=m.id AND c.state='open'
 JOIN meetup.conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1
 JOIN graph.dogs a ON a.id=m.dog_a_id JOIN graph.dogs b ON b.id=m.dog_b_id
 JOIN identity.households ha ON ha.id=a.household_id JOIN identity.households hb ON hb.id=b.household_id
 WHERE m.state='active' AND a.status='active' AND b.status='active' AND a.deleted_at IS NULL AND b.deleted_at IS NULL AND ha.deleted_at IS NULL AND hb.deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM identity.household_members own WHERE own.user_id=$1 AND own.household_id IN(a.household_id,b.household_id) AND own.accepted_at IS NOT NULL AND own.role IN('owner','co_guardian'))
 AND NOT EXISTS(SELECT 1 FROM identity.household_members x JOIN safety.blocks block ON block.blocker_user_id=x.user_id OR block.blocked_user_id=x.user_id
 JOIN identity.household_members y ON y.user_id=CASE WHEN block.blocker_user_id=x.user_id THEN block.blocked_user_id ELSE block.blocker_user_id END
 WHERE x.household_id=a.household_id AND y.household_id=b.household_id AND x.accepted_at IS NOT NULL AND y.accepted_at IS NOT NULL)
 ) SELECT (SELECT count(*)::int FROM visible) AS connections,
 (SELECT count(*)::int FROM meetup.messages msg JOIN visible v ON v.conversation_id=msg.conversation_id WHERE msg.seq>v.last_read_seq AND msg.sender_user_id<>$1 AND msg.deleted_at IS NULL) AS messages,
 (SELECT count(*)::int FROM identity.notifications n JOIN visible v ON v.conversation_id=n.conversation_id WHERE n.user_id=$1 AND n.read_at IS NULL) AS notifications,
 (SELECT count(*)::int FROM meetup.meetups meeting JOIN visible v ON v.id=meeting.match_id JOIN meetup.meetup_participants p ON p.meetup_id=meeting.id WHERE p.user_id=$1 AND meeting.state IN ('proposed','accepted','in_progress') AND meeting.window_end>now() AND (meeting.state<>'proposed' OR meeting.window_start>now())) AS meetup`,[userId])).rows[0];
 return {connections:{status:'available',value:row.connections},messages:{status:messagesAvailable?'available':'unavailable',value:messagesAvailable?row.messages:null},meetup:{status:'available',value:row.meetup},notifications:{status:'available',value:row.notifications}};
}
