import { beforeEach,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../support/fixture.js';
import { runMaintenance } from '../../src/modules/ops/maintenance.js';
const f=fixture();
beforeEach(async()=>{await f.setup();await f.database.query('TRUNCATE ops.maintenance_status');});after(()=>f.close());

test('maintenance clears expired ephemeral data, keeps recent records and is repeatable',async()=>{
 const user=await f.user(),household=await f.household(user.userId),dog=await f.dog(household);
 await f.database.query(`INSERT INTO graph.discovery_sessions(id,user_id,actor_dog_id,context_hash,target_ids,created_at,expires_at)
 VALUES($1,$2,$3,'test',ARRAY[]::uuid[],now()-interval '2 days',now()-interval '2 days'),
 ($4,$2,$3,'test',ARRAY[]::uuid[],now(),now()+interval '10 minutes')`,[randomUUID(),user.userId,dog,randomUUID()]);
 await f.database.query("INSERT INTO graph.discovery_profile_reads(user_id,day,dog_id) VALUES($1,(now() AT TIME ZONE 'UTC')::date-1,$2),($1,(now() AT TIME ZONE 'UTC')::date,$2)",[user.userId,dog]);
 const session=(await f.database.query('SELECT id FROM identity.sessions WHERE user_id=$1 LIMIT 1',[user.userId])).rows[0].id;
 await f.database.query("INSERT INTO meetup.realtime_tickets(token_hash,user_id,session_id,expires_at) VALUES($1,$2,$3,now()-interval '2 days'),($4,$2,$3,now()+interval '30 seconds')",[randomUUID(),user.userId,session,randomUUID()]);
 await f.database.query("INSERT INTO identity.privacy_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()-interval '2 days'),($3,$2,now()+interval '30 minutes')",[randomUUID(),user.userId,randomUUID()]);
 const first=await runMaintenance(f.database);assert.equal(first.status,'completed');if(first.status!=='completed')return;
 assert.deepEqual(first.discovery,{sessions:1,reads:1});
 const state=(await f.database.query('SELECT run_id,status,summary FROM ops.maintenance_status WHERE singleton')).rows[0];assert.equal(state.status,'completed');assert.equal(state.run_id,first.runId);assert.equal(state.summary.discovery.sessions,1);assert.deepEqual(first.ephemeral,{tickets:1,tokens:1});
 const second=await runMaintenance(f.database);assert.equal(second.status,'completed');if(second.status==='completed'){assert.deepEqual(second.discovery,{sessions:0,reads:0});assert.deepEqual(second.ephemeral,{tickets:0,tokens:0});}
 assert.equal((await f.database.query('SELECT count(*)::int n FROM graph.discovery_sessions')).rows[0].n,1);
 assert.equal((await f.database.query('SELECT count(*)::int n FROM meetup.realtime_tickets')).rows[0].n,1);
});

test('overlapping maintenance pass reports already running without deleting anything',async()=>{
 const lock=await f.database.connect();try{
  await lock.query('SELECT pg_advisory_lock($1)',[70419002]);
  assert.deepEqual(await runMaintenance(f.database),{status:'already_running'});
  assert.equal((await f.database.query('SELECT count(*)::int n FROM ops.maintenance_status')).rows[0].n,0);
 }finally{await lock.query('SELECT pg_advisory_unlock($1)',[70419002]);lock.release();}
});
