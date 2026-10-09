import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomBytes,randomUUID } from 'node:crypto';import request from 'supertest';
import { fixture } from '../support/fixture.js';import { LocalMessageCipher } from '../../src/modules/messages/message-cipher.js';import type { StaffIdentity } from '../../src/modules/admin/staff-auth.js';
const issuer='https://staff.test.invalid',identities=new Map<string,StaffIdentity>(),cipher=new LocalMessageCipher(randomBytes(32).toString('hex'),'test');
const f=fixture(undefined,undefined,cipher,{async verify(token){const identity=identities.get(token);if(!identity)throw new Error('untrusted');return identity;}}),http=request(f.app);
let one:string,two:string;
beforeEach(async()=>{await f.setup();await f.database.query('TRUNCATE ops.staff_accounts CASCADE');identities.clear();for(const subject of ['one','two','support'])identities.set(subject,{issuer,subject,mfa:true,authenticatedAt:Date.now()/1000});
 one=(await f.database.query('INSERT INTO ops.staff_accounts(issuer,subject,roles) VALUES($1,$2,$3) RETURNING id',[issuer,'one',['moderator','appeals','support','city_ops','operations']])).rows[0].id;
 two=(await f.database.query('INSERT INTO ops.staff_accounts(issuer,subject,roles) VALUES($1,$2,$3) RETURNING id',[issuer,'two',['moderator','appeals']])).rows[0].id;
 await f.database.query('INSERT INTO ops.staff_accounts(issuer,subject,roles) VALUES($1,$2,$3)',[issuer,'support',['support']]);});after(()=>f.close());
test('staff identity requires MFA, recent authentication, live provisioning and database role',async()=>{
 const user=await f.user();await http.get('/admin/v1/jobs').set('Authorization',user.header).expect(401);
 await http.get('/admin/v1/jobs').set('Authorization','Bearer support').expect(403);
 identities.set('badmfa',{issuer,subject:'one',mfa:false,authenticatedAt:Date.now()/1000});await http.get('/admin/v1/jobs').set('Authorization','Bearer badmfa').expect(401);
 identities.set('old',{issuer,subject:'one',mfa:true,authenticatedAt:Date.now()/1000-1000});await http.get('/admin/v1/jobs').set('Authorization','Bearer old').expect(401);
 await http.get('/admin/v1/jobs').set('Authorization','Bearer one').expect(200);
 await f.database.query('UPDATE ops.staff_accounts SET active=false WHERE id=$1',[one]);await http.get('/admin/v1/jobs').set('Authorization','Bearer one').expect(403);
});
test('report narrative requires exclusive claim and every read/action is audited without narrative',async()=>{
 const user=await f.user(),id=randomUUID(),text='PRIVATE CASE TEST';await f.database.query("INSERT INTO safety.reports(id,reporter_user_id,subject_type,subject_id,category,severity,narrative_encrypted) VALUES($1,$2,'user',$2,'other',1,$3)",[id,user.userId,cipher.wrap(Buffer.from(text),`report:${id}`)]);
 await http.get(`/admin/v1/reports/${id}`).set('Authorization','Bearer one').expect(404);
 const results=await Promise.all(['one','two'].map(token=>http.post(`/admin/v1/reports/${id}/claim`).set('Authorization',`Bearer ${token}`).send({})));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const winner=results[0].status===200?'one':'two';assert.equal((await http.get(`/admin/v1/reports/${id}`).set('Authorization',`Bearer ${winner}`).expect(200)).body.details,text);
 await http.post(`/admin/v1/reports/${id}/decide`).set('Authorization',`Bearer ${winner}`).send({decision:'dismissed',reason:'Reviewed fixture case'}).expect(200);
 const audits=(await f.database.query("SELECT action,before,after FROM ops.audit_log WHERE actor_kind='staff' AND subject_id=$1",[id])).rows;assert.equal(audits.length,3);assert.ok(!JSON.stringify(audits).includes(text));
});
test('suspension revokes sessions; independent appeal overturn restores prior pending state only',async()=>{
 const user=await f.user(),action=(await http.post(`/admin/v1/users/${user.userId}/actions`).set('Authorization','Bearer one').send({action:'suspend',reasonCode:'test_reason',policyRef:'TEST POLICY'}).expect(200)).body;
 await http.get('/v1/me').set('Authorization',user.header).expect(401);const appeal=randomUUID();await f.database.query('INSERT INTO safety.appeals(id,action_id,user_id,statement_encrypted) VALUES($1,$2,$3,$4)',[appeal,action.actionId,user.userId,cipher.wrap(Buffer.from('Appeal fixture'),`appeal:${appeal}`)]);
 await http.post(`/admin/v1/appeals/${appeal}/decide`).set('Authorization','Bearer one').send({decision:'overturn',outcome:'Review completed'}).expect(403);
 await http.post(`/admin/v1/appeals/${appeal}/decide`).set('Authorization','Bearer two').send({decision:'overturn',outcome:'Review completed'}).expect(200);
 assert.equal((await f.database.query('SELECT status FROM identity.users WHERE id=$1',[user.userId])).rows[0].status,'pending');await http.get('/v1/me').set('Authorization',user.header).expect(401);
});
test('staff can review submitted public places and reply privately to support',async()=>{
 const user=await f.user();const suggestion=(await http.post('/v1/places/suggestions').set('Authorization',user.header).send({name:'TEST PLACE',kind:'offleash_park',latitude:12.9,longitude:77.5,address:'TEST PUBLIC PLACE',metroId:'01920000-0000-7000-8000-0000000e0001',isFenced:true,hasWater:true}).expect(201)).body;
 await http.patch(`/admin/v1/places/${suggestion.id}`).set('Authorization','Bearer one').send({state:'approved'}).expect(200);
 await http.get(`/v1/places/${suggestion.id}`).set('Authorization',user.header).expect(200);
 const ticket=(await http.post('/v1/support/tickets').set('Authorization',user.header).set('Idempotency-Key',randomUUID()).send({category:'technical',message:'TEST support question'}).expect(201)).body;
 await http.post(`/admin/v1/support/tickets/${ticket.id}/messages`).set('Authorization','Bearer support').send({message:'TEST support reply',resolve:true}).expect(201);
 const detail=(await http.get(`/v1/support/tickets/${ticket.id}`).set('Authorization',user.header)).body;assert.equal(detail.ticket.state,'resolved');assert.ok(detail.messages.some((m:{body:string})=>m.body==='TEST support reply'));
});
