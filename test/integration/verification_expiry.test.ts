import { beforeEach,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../support/fixture.js';
import { processVerificationExpiry } from '../../src/modules/verification/expiry-worker.js';
const f=fixture();beforeEach(()=>f.setup());after(()=>f.close());

test('expired guardian tier clears verified flag, pauses publication and is idempotent',async()=>{
 const user=await f.user(),dog=await f.dog(await f.household(user.userId));
 await f.database.query("UPDATE identity.users SET status='active',is_adult_verified=true WHERE id=$1",[user.userId]);
 await f.database.query("UPDATE graph.dogs SET publication_state='published',published_by=$2 WHERE id=$1",[dog,user.userId]);
 await f.database.query("INSERT INTO verify.tiers_granted(subject_type,subject_id,tier,expires_at) VALUES('user',$1,1,now()-interval '1 minute')",[user.userId]);
 assert.deepEqual(await processVerificationExpiry(f.database),{revoked:1,guardians:1});
 assert.equal((await f.database.query('SELECT is_adult_verified FROM identity.users WHERE id=$1',[user.userId])).rows[0].is_adult_verified,false);
 assert.equal((await f.database.query('SELECT publication_state FROM graph.dogs WHERE id=$1',[dog])).rows[0].publication_state,'paused');
 assert.equal((await f.database.query("SELECT revoked_reason FROM verify.tiers_granted WHERE subject_type='user' AND subject_id=$1 AND tier=1",[user.userId])).rows[0].revoked_reason,'expired');
 assert.deepEqual(await processVerificationExpiry(f.database),{revoked:0,guardians:0});
});

test('an unexpired higher guardian tier keeps verified state while lower tier expires',async()=>{
 const user=await f.user();await f.database.query('UPDATE identity.users SET is_adult_verified=true WHERE id=$1',[user.userId]);
 await f.database.query("INSERT INTO verify.tiers_granted(subject_type,subject_id,tier,expires_at) VALUES('user',$1,1,now()-interval '1 minute'),('user',$1,2,now()+interval '1 day')",[user.userId]);
 assert.deepEqual(await processVerificationExpiry(f.database),{revoked:1,guardians:0});
 assert.equal((await f.database.query('SELECT is_adult_verified FROM identity.users WHERE id=$1',[user.userId])).rows[0].is_adult_verified,true);
});
