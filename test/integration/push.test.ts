import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { fixture } from '../support/fixture.js';import { LocalMessageCipher } from '../../src/modules/messages/message-cipher.js';import { deliverPushBatch,type PushProvider } from '../../src/modules/notifications/push-worker.js';import { BlocksService } from '../../src/modules/safety/blocks.service.js';
const cipher=new LocalMessageCipher(randomBytes(32).toString('hex'),'test'),f=fixture(undefined,undefined,cipher);beforeEach(()=>f.setup());after(()=>f.close());
async function ready(){
 const a=await f.user(),b=await f.user(),ha=await f.household(a.userId),hb=await f.household(b.userId),dogs=[await f.dog(ha),await f.dog(hb)].sort(),match=randomUUID(),conversation=randomUUID(),notification=randomUUID();
 await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES($1,$2,$3,$4,'pack')",[match,dogs.join(':'),...dogs]);await f.database.query('INSERT INTO meetup.conversations(id,match_id) VALUES($1,$2)',[conversation,match]);for(const u of [a,b])await f.database.query('INSERT INTO meetup.conversation_members(conversation_id,user_id) VALUES($1,$2)',[conversation,u.userId]);
 await f.database.query("INSERT INTO identity.notifications(id,user_id,event_id,category,conversation_id) VALUES($1,$2,$3,'messages',$4)",[notification,b.userId,randomUUID(),conversation]);await f.database.query('INSERT INTO ops.push_jobs(notification_id) VALUES($1)',[notification]);
 await f.database.query('INSERT INTO identity.notification_preferences(user_id,push_enabled) VALUES($1,true)',[b.userId]);const session=(await f.database.query('SELECT device_id,family_id FROM identity.sessions WHERE user_id=$1',[b.userId])).rows[0];
 const token='TEST_PUSH_TOKEN_ONLY',tokenHash=createHash('sha256').update(token).digest('hex');await f.database.query("INSERT INTO identity.devices(installation_id,user_id,family_id,platform,provider,token_hash,token_encrypted,locale,app_build) VALUES($1,$2,$3,'android','fcm',$4,$5,'en-IN',1)",[session.device_id,b.userId,session.family_id,tokenHash,cipher.wrap(Buffer.from(token),`device:${session.device_id}`)]);
 return {a,b,notification,installation:session.device_id};
}
test('without a provider jobs stay queued; concurrent workers lease once and persist safe receipts',async()=>{
 const p=await ready();assert.equal((await deliverPushBatch(f.database,cipher)).providerAvailable,false);
 let calls=0;const provider:PushProvider={supports:()=>true,async send(input){calls++;assert.equal(input.token,'TEST_PUSH_TOKEN_ONLY');assert.deepEqual(Object.keys(input.payload).sort(),['category','notificationId','title']);return {status:'delivered'};}};
 const results=await Promise.all([deliverPushBatch(f.database,cipher,provider),deliverPushBatch(f.database,cipher,provider)]);assert.equal(calls,1);assert.equal(results.reduce((n,r)=>n+r.delivered,0),1);
 assert.equal((await f.database.query('SELECT count(*)::int n FROM ops.push_delivery_receipts WHERE notification_id=$1',[p.notification])).rows[0].n,1);
});
test('transient failures back off durably and exhaust into dead letter without storing provider secrets',async()=>{
 const p=await ready(),provider:PushProvider={supports:()=>true,async send(){throw new Error('SECRET PROVIDER DETAILS');}};
 assert.equal((await deliverPushBatch(f.database,cipher,provider)).retrying,1);assert.equal((await deliverPushBatch(f.database,cipher,provider)).claimed,0);
 await f.database.query("UPDATE ops.push_jobs SET attempts=4,available_at=now()-interval '1 second' WHERE notification_id=$1",[p.notification]);assert.equal((await deliverPushBatch(f.database,cipher,provider)).deadLetter,1);
 const row=(await f.database.query('SELECT state,last_error FROM ops.push_jobs WHERE notification_id=$1',[p.notification])).rows[0];assert.equal(row.state,'dead_letter');assert.equal(row.last_error,'retries_exhausted');
});
test('provider quota retry hint is persisted on the queued job',async()=>{
 const p=await ready(),provider:PushProvider={supports:()=>true,async send(){return {status:'transient_failure',retryAfterSeconds:120};}};
 assert.equal((await deliverPushBatch(f.database,cipher,provider)).retrying,1);
 const row=(await f.database.query('SELECT available_at FROM ops.push_jobs WHERE notification_id=$1',[p.notification])).rows[0];
 assert.ok(new Date(row.available_at).getTime()-Date.now()>110_000);
});
test('quiet hours defer without consuming attempts; subsequent block suppresses delivery',async()=>{
 const p=await ready(),now=new Date(),minute=now.getUTCHours()*60+now.getUTCMinutes();await f.database.query("UPDATE identity.notification_preferences SET timezone='UTC',quiet_start=$2,quiet_end=$3 WHERE user_id=$1",[p.b.userId,(minute+1439)%1440,(minute+3)%1440]);
 let calls=0;const provider:PushProvider={supports:()=>true,async send(){calls++;return {status:'delivered'};}};assert.equal((await deliverPushBatch(f.database,cipher,provider)).deferred,1);assert.equal((await f.database.query('SELECT attempts FROM ops.push_jobs')).rows[0].attempts,0);
 await new BlocksService(f.database).add(p.a.userId,p.b.userId);await f.database.query('UPDATE ops.push_jobs SET available_at=now()');assert.equal((await deliverPushBatch(f.database,cipher,provider)).suppressed,1);assert.equal(calls,0);
});
test('invalid-token feedback cannot delete a registration rotated while send was in flight',async()=>{
 const p=await ready(),newToken='TEST_ROTATED_TOKEN';const provider:PushProvider={supports:()=>true,async send(){await f.database.query('UPDATE identity.devices SET token_hash=$2,token_encrypted=$3 WHERE installation_id=$1',[p.installation,createHash('sha256').update(newToken).digest('hex'),cipher.wrap(Buffer.from(newToken),`device:${p.installation}`)]);return {status:'invalid_token'};}};
 await deliverPushBatch(f.database,cipher,provider);assert.equal((await f.database.query('SELECT count(*)::int n FROM identity.devices WHERE installation_id=$1',[p.installation])).rows[0].n,1);
});
