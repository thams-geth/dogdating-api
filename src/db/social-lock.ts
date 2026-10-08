import type { PoolClient } from 'pg';
// Development-scale serialization for block/relationship/chat mutations. Acquire BEFORE user/household locks.
// Replace only with a reviewed finer-grained locking protocol shared by every social writer.
export async function socialLock(tx:PoolClient){await tx.query('SELECT pg_advisory_xact_lock(70419001)');}
export async function householdsBlocked(tx:PoolClient,a:string,b:string){return (await tx.query(`SELECT EXISTS(
 SELECT 1 FROM identity.household_members x JOIN safety.blocks block ON block.blocker_user_id=x.user_id OR block.blocked_user_id=x.user_id
 JOIN identity.household_members y ON y.user_id=CASE WHEN block.blocker_user_id=x.user_id THEN block.blocked_user_id ELSE block.blocker_user_id END
 WHERE x.household_id=$1 AND y.household_id=$2 AND x.accepted_at IS NOT NULL AND y.accepted_at IS NOT NULL) AS blocked`,[a,b])).rows[0]!.blocked as boolean;}
