import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';import request from 'supertest';import { fixture } from '../support/fixture.js';
const f=fixture(),http=request(f.app);beforeEach(()=>f.setup());after(()=>f.close());
async function begin(header:string,phoneE164:string){await http.post('/v1/auth/phone-change/request').set('Authorization',header).send({phoneE164,countryCode:'IN'}).expect(202);return f.code(phoneE164)!;}
test('phone change requires destination proof, commits failed guesses and revokes old sessions',async()=>{
 const a=await f.user(),b=await f.user(),phone='+919888123456',code=await begin(a.header,phone);
 await http.post('/v1/auth/phone-change/verify').set('Authorization',b.header).send({phoneE164:phone,code}).expect(401);
 const bad=code==='000000'?'111111':'000000';await http.post('/v1/auth/phone-change/verify').set('Authorization',a.header).send({phoneE164:phone,code:bad}).expect(401);
 assert.equal((await f.database.query("SELECT attempt_count FROM identity.otp_challenges WHERE purpose='phone_change'")).rows[0].attempt_count,1);
 await http.post('/v1/auth/otp/verify').send({phoneE164:phone,code,deviceId:randomUUID(),displayName:'Wrong purpose'}).expect(401);
 const result=await http.post('/v1/auth/phone-change/verify').set('Authorization',a.header).send({phoneE164:phone,code}).expect(200);assert.equal(result.body.status,'sign_in_required');
 await http.get('/v1/me').set('Authorization',a.header).expect(401);assert.equal((await f.database.query('SELECT phone_e164 FROM identity.users WHERE id=$1',[a.userId])).rows[0].phone_e164,phone);
});
test('existing phone collision never merges accounts; stale sign-in cannot request a change',async()=>{
 const a=await f.user(),b=await f.user();await f.database.query("UPDATE identity.otp_challenges SET created_at=now()-interval '2 minutes'");const code=await begin(a.header,b.phone);
 await http.post('/v1/auth/phone-change/verify').set('Authorization',a.header).send({phoneE164:b.phone,code}).expect(409);
 assert.equal((await f.database.query('SELECT count(*)::int n FROM identity.users')).rows[0].n,2);
 await f.database.query("UPDATE identity.sessions SET created_at=now()-interval '1 hour' WHERE user_id=$1",[a.userId]);
 await http.post('/v1/auth/phone-change/request').set('Authorization',a.header).send({phoneE164:'+919888123457',countryCode:'IN'}).expect(403);
});
