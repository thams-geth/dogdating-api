import { defaultPolicy } from '../../src/modules/app/policy.js';
import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomBytes,randomUUID } from 'node:crypto';import request from 'supertest';
import { fixture } from '../support/fixture.js';import { LocalMessageCipher } from '../../src/modules/messages/message-cipher.js';import type { StaffIdentity } from '../../src/modules/admin/staff-auth.js';
const issuer='https://staff.test.invalid',identities=new Map<string,StaffIdentity>(),cipher=new LocalMessageCipher(randomBytes(32).toString('hex'),'test');
const f=fixture(undefined,undefined,cipher,{async verify(token){const identity=identities.get(token);if(!identity)throw new Error('untrusted');return identity;}}),http=request(f.app);
let one:string,two:string;
beforeEach(async()=>{await f.setup();await f.database.query(`INSERT INTO ops.metros(id,name,country,admin_region,timezone,currency,launch_state)
 VALUES('01920000-0000-7000-8000-0000000e0001','Bengaluru','IN','KA','Asia/Kolkata','INR','seeding') ON CONFLICT(id) DO NOTHING`);
 await f.database.query('TRUNCATE ops.staff_accounts CASCADE');identities.clear();for(const subject of ['one','two','support'])identities.set(subject,{issuer,subject,mfa:true,authenticatedAt:Date.now()/1000});
 one=(await f.database.query('INSERT INTO ops.staff_accounts(issuer,subject,roles) VALUES($1,$2,$3) RETURNING id',[issuer,'one',['moderator','appeals','support','city_ops','operations','release_ops','legal_ops','reviewer']])).rows[0].id;
 two=(await f.database.query('INSERT INTO ops.staff_accounts(issuer,subject,roles) VALUES($1,$2,$3) RETURNING id',[issuer,'two',['moderator','appeals']])).rows[0].id;
 await f.database.query('INSERT INTO ops.staff_accounts(issuer,subject,roles) VALUES($1,$2,$3)',[issuer,'support',['support']]);await f.database.query('INSERT INTO ops.app_release_policy(singleton,policy) VALUES(true,$1)',[defaultPolicy]);});after(()=>f.close());
test('staff identity requires MFA, recent authentication, live provisioning and database role',async()=>{
 const user=await f.user();await http.get('/admin/v1/jobs').set('Authorization',user.header).expect(401);
 await http.get('/admin/v1/jobs').set('Authorization','Bearer support').expect(403);
 identities.set('badmfa',{issuer,subject:'one',mfa:false,authenticatedAt:Date.now()/1000});await http.get('/admin/v1/jobs').set('Authorization','Bearer badmfa').expect(401);
 identities.set('old',{issuer,subject:'one',mfa:true,authenticatedAt:Date.now()/1000-1000});await http.get('/admin/v1/jobs').set('Authorization','Bearer old').expect(401);
 await http.get('/admin/v1/jobs').set('Authorization','Bearer one').expect(200);
 await f.database.query('UPDATE ops.staff_accounts SET active=false WHERE id=$1',[one]);await http.get('/admin/v1/jobs').set('Authorization','Bearer one').expect(403);
});
test('city operations edit only India development rollout with version and audit',async()=>{
 const id=randomUUID(),foreign=randomUUID();
 await f.database.query(`INSERT INTO ops.metros(id,name,country,admin_region,timezone,currency,launch_state)
   VALUES($1,'Test City','IN','KA','Asia/Kolkata','INR','prospect'),($2,'Foreign Test','US','CA','America/Los_Angeles','USD','prospect')`,[id,foreign]);
 const path=`/admin/v1/areas/${id}`,auth={Authorization:'Bearer one'};
 await http.get('/admin/v1/areas').set('Authorization','Bearer support').expect(403);
 const listed=(await http.get('/admin/v1/areas').set(auth).expect(200)).body;
 assert.ok(listed.items.some((a:{id:string})=>a.id===id));assert.ok(!listed.items.some((a:{id:string})=>a.id===foreign));
 await http.patch(path).set('Authorization','Bearer support').send({expectedVersion:1,state:'seeding',reasonCode:'test_ready'}).expect(403);
 await http.patch(path).set(auth).send({expectedVersion:1,state:'open',reasonCode:'test_ready'}).expect(400);
 await http.patch(`/admin/v1/areas/${foreign}`).set(auth).send({expectedVersion:1,state:'seeding',reasonCode:'test_ready'}).expect(404);
 const changed=(await http.patch(path).set(auth).send({expectedVersion:1,state:'seeding',reasonCode:'test_ready'}).expect(200)).body;
 assert.equal(changed.version,2);assert.equal(changed.state,'seeding');
 const user=await f.user(),householdId=await f.household(user.userId),dogId=await f.dog(householdId);
 await f.database.query("UPDATE identity.households SET metro_id=$2,location_source='manual_area' WHERE id=$1",[householdId,id]);
 await f.database.query("UPDATE graph.dogs SET publication_state='published' WHERE id=$1",[dogId]);
 await f.database.query("INSERT INTO graph.dog_availability(id,dog_id,beacon_until) VALUES($1,$2,now()+interval '1 hour')",[randomUUID(),dogId]);
 assert.ok((await http.get('/v1/app/areas?countryCode=IN&query=Test%20City').expect(200)).body.areas.some((a:{id:string,selectable:boolean})=>a.id===id&&a.selectable));
 await http.patch(path).set(auth).send({expectedVersion:1,state:'waitlist',reasonCode:'test_pause'}).expect(409).then(r=>assert.equal(r.body.code,'area-version-conflict'));
 const paused=(await http.patch(path).set(auth).send({expectedVersion:2,state:'waitlist',reasonCode:'test_pause'}).expect(200)).body;
 assert.equal(paused.version,3);assert.equal(paused.state,'waitlist');
 assert.equal((await f.database.query('SELECT publication_state FROM graph.dogs WHERE id=$1',[dogId])).rows[0].publication_state,'draft');
 assert.equal((await f.database.query('SELECT count(*)::int AS n FROM graph.dog_availability WHERE dog_id=$1',[dogId])).rows[0].n,0);
 assert.equal((await http.get('/v1/app/areas?countryCode=IN&query=Test%20City').expect(200)).body.areas[0].selectable,false);
 const same=(await http.patch(path).set(auth).send({expectedVersion:3,state:'waitlist',reasonCode:'test_pause'}).expect(200)).body;assert.equal(same.version,3);
 const audit=(await f.database.query("SELECT before,after FROM ops.audit_log WHERE action='area.rollout.update' AND subject_id=$1 ORDER BY id",[id])).rows;
 assert.equal(audit.length,2);assert.deepEqual(audit[1].after,{state:'waitlist',version:3,reasonCode:'test_pause'});
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

test('release changes require role, trusted store URL and optimistic version, and reach bootstrap',async()=>{
 const policy={...defaultPolicy,revision:'fixture-release',android:{minimumBuild:2,latestBuild:3,storeUrl:'https://play.google.com/store/apps/details?id=fixture'}};
 await http.patch('/admin/v1/app-releases').set('Authorization','Bearer support').send({expectedVersion:1,policy,storeAvailabilityConfirmed:true}).expect(403);
 await http.patch('/admin/v1/app-releases').set('Authorization','Bearer one').send({expectedVersion:1,policy:{...policy,android:{...policy.android,storeUrl:'https://not-a-store.invalid/app'}},storeAvailabilityConfirmed:true}).expect(400);
 const changes=await Promise.all([1,2].map(()=>http.patch('/admin/v1/app-releases').set('Authorization','Bearer one').send({expectedVersion:1,policy,storeAvailabilityConfirmed:true})));assert.deepEqual(changes.map(r=>r.status).sort(),[200,409]);
 const obsolete=await http.get('/v1/dogs').set('X-App-Platform','android').set('X-App-Build','1').expect(426);assert.equal(obsolete.body.code,'update-required');
 const current=await http.get('/v1/dogs').set('X-App-Platform','android').set('X-App-Build','2');assert.notEqual(current.status,426);
 await http.get('/v1/reports/77777777-7777-4777-8777-777777777777').expect(401);
 const bootstrap=(await http.get('/v1/app/bootstrap?platform=android&buildNumber=1').expect(200)).body;assert.equal(bootstrap.update.action,'required');assert.equal(bootstrap.policyRevision,'fixture-release');assert.equal(bootstrap.features.pack,false);
});
test('legal drafts are private until explicit publication; published text stays immutable',async()=>{
 const payload={purpose:'privacy',version:'fixture-reviewed-v1',countryCode:'IN',locale:'en-IN',body:'TEST FIXTURE CONTENT ONLY — NOT AN ACTUAL LEGAL POLICY.',reviewReference:'TEST REVIEW ONLY'};
 const document=(await http.post('/admin/v1/legal/documents').set('Authorization','Bearer one').send(payload).expect(201)).body;
 await http.get('/v1/legal/documents/privacy?countryCode=IN&locale=en-IN').expect(404);
 await http.post(`/admin/v1/legal/documents/${document.id}/publish`).set('Authorization','Bearer support').send({reviewConfirmed:true}).expect(403);
 await http.post(`/admin/v1/legal/documents/${document.id}/publish`).set('Authorization','Bearer one').send({reviewConfirmed:true}).expect(200);
 const bootstrap=(await http.get('/v1/app/bootstrap?platform=ios&buildNumber=1').expect(200)).body;assert.equal(bootstrap.legal.privacyVersion,payload.version);
 await assert.rejects(f.database.query('UPDATE identity.policy_documents SET body=$2 WHERE id=$1',[document.id,'changed']));
 await http.post('/admin/v1/legal/documents').set('Authorization','Bearer one').send(payload).expect(409);
});
test('operations can inspect and retry dead-letter pushes without gaining private payload access',async()=>{
 const user=await f.user(),household=await f.household(user.userId),dogs=[await f.dog(household),await f.dog(household)].sort(),match=randomUUID(),conversation=randomUUID(),notification=randomUUID();
 await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES($1,$2,$3,$4,'pack')",[match,dogs.join(':'),...dogs]);await f.database.query('INSERT INTO meetup.conversations(id,match_id) VALUES($1,$2)',[conversation,match]);
 await f.database.query("INSERT INTO identity.notifications(id,user_id,event_id,category,conversation_id) VALUES($1,$2,$3,'messages',$4)",[notification,user.userId,randomUUID(),conversation]);await f.database.query("INSERT INTO ops.push_jobs(notification_id,state,attempts,last_error) VALUES($1,'dead_letter',5,'retries_exhausted')",[notification]);
 await http.get('/admin/v1/notifications/jobs').set('Authorization','Bearer support').expect(403);
 const jobs=(await http.get('/admin/v1/notifications/jobs').set('Authorization','Bearer one').expect(200)).body;assert.equal(jobs.items[0].id,notification);assert.equal(jobs.items[0].lastError,'retries_exhausted');assert.ok(!('userId' in jobs.items[0]));
 await http.post(`/admin/v1/notifications/jobs/${notification}/retry`).set('Authorization','Bearer one').send({}).expect(200);
 await http.post(`/admin/v1/notifications/jobs/${notification}/retry`).set('Authorization','Bearer one').send({}).expect(409);
});

test('meetup safety incidents queue privately, require exclusive reviewer claim and audit decisions',async()=>{
 const user=await f.user(),reviewId=randomUUID(),caseNote='PRIVATE INCIDENT TEST',dog=await f.dog(await f.household(user.userId));
 const other=await f.dog(await f.household((await f.user()).userId));
 const dogs=[dog,other].sort(),match=randomUUID(),meetup=randomUUID(),metro='01920000-0000-7000-8000-0000000e0001',place=randomUUID();
 await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES($1,$2,$3,$4,'pack')",[match,dogs.join(':'),...dogs]);
 await f.database.query("INSERT INTO meetup.places(id,name,kind,latitude,longitude,address,metro_id,state,verified_at) VALUES($1,'TEST PARK','offleash_park',12.9,77.5,'TEST ADDRESS',$2,'approved',now())",[place,metro]);
 await f.database.query("INSERT INTO meetup.meetups(id,match_id,place_id,kind,window_start,window_end,proposed_by) VALUES($1,$2,$3,'parallel_walk',now()-interval '2 hours',now()-interval '1 hour',$4)",[meetup,match,place,user.userId]);
 await f.database.query("INSERT INTO meetup.meetup_reviews(id,meetup_id,reviewer_user_id,subject_dog_id,showed_up,would_repeat,incident_occurred,incident_type,private_note_encrypted) VALUES($1,$2,$3,$4,true,false,true,'other',$5)",[reviewId,meetup,user.userId,other,cipher.wrap(Buffer.from(caseNote),`review:${reviewId}`)]);
 const list=(await http.get('/admin/v1/meetup-incidents').set('Authorization','Bearer one').expect(200)).body;const id=list.items[0].id;assert.ok(!JSON.stringify(list).includes(caseNote));
 await http.get(`/admin/v1/meetup-incidents/${id}`).set('Authorization','Bearer one').expect(404);
 await http.get('/admin/v1/meetup-incidents').set('Authorization','Bearer support').expect(403);
 await http.post(`/admin/v1/meetup-incidents/${id}/claim`).set('Authorization','Bearer one').send({}).expect(200);
 assert.equal((await http.get(`/admin/v1/meetup-incidents/${id}`).set('Authorization','Bearer one').expect(200)).body.privateNote,caseNote);
 await http.post(`/admin/v1/meetup-incidents/${id}/decide`).set('Authorization','Bearer one').send({decision:'escalated',reasonCode:'needs_review'}).expect(200);
 await http.post(`/admin/v1/meetup-incidents/${id}/decide`).set('Authorization','Bearer one').send({decision:'dismissed',reasonCode:'reviewed'}).expect(409);
 assert.ok(!JSON.stringify((await f.database.query('SELECT action,before,after FROM ops.audit_log WHERE subject_id=$1',[id])).rows).includes(caseNote));
});

test('operations browse redacted audit metadata with bounded windows and scoped cursors',async()=>{
 const subject=randomUUID();for(let i=0;i<3;i++)await f.database.query("INSERT INTO ops.audit_log(actor_kind,action,subject_type,subject_id,before) VALUES('system','test.audit','user',$1,$2)",[subject,{secret:'PRIVATE AUDIT CONTENT'}]);
 await http.get('/admin/v1/audit-events').set('Authorization','Bearer support').expect(403);
 const first=(await http.get('/admin/v1/audit-events?limit=2&action=test.audit').set('Authorization','Bearer one').expect(200)).body;
 assert.equal(first.items.length,2);assert.ok(first.nextCursor);assert.ok(!JSON.stringify(first).includes('PRIVATE AUDIT CONTENT'));
 const second=(await http.get('/admin/v1/audit-events').query({limit:'2',action:'test.audit',from:first.from,to:first.to,cursor:first.nextCursor}).set('Authorization','Bearer one').expect(200)).body;
 assert.equal(second.items.length,1);assert.notEqual(second.items[0].id,first.items[0].id);
 await http.get('/admin/v1/audit-events').query({action:'other',from:first.from,to:first.to,cursor:first.nextCursor}).set('Authorization','Bearer one').expect(400);
 await http.get('/admin/v1/audit-events').query({from:'2025-01-01T00:00:00Z',to:'2025-03-01T00:00:00Z'}).set('Authorization','Bearer one').expect(400);
});

test('operations jobs view exposes only maintenance status and aggregate counts',async()=>{
 const {runMaintenance}=await import('../../src/modules/ops/maintenance.js');
 const run=await runMaintenance(f.database);assert.equal(run.status,'completed');
 const jobs=(await http.get('/admin/v1/jobs').set('Authorization','Bearer one').expect(200)).body;
 assert.equal(jobs.maintenance.status,'completed');assert.equal(jobs.maintenance.runId,run.status==='completed'?run.runId:null);
 assert.ok(!('privateNote' in jobs.maintenance));
 await http.get('/admin/v1/jobs').set('Authorization','Bearer support').expect(403);
});
test('support browses redacted user and dog directories while operations sees aggregate overview',async()=>{
 const guardian=await f.user(),household=await f.household(guardian.userId),dogId=await f.dog(household);
 const users=(await http.get('/admin/v1/users?limit=1').set('Authorization','Bearer support').expect(200)).body;
 assert.equal(users.items.length,1);assert.ok(users.nextCursor);assert.ok(!('phoneE164' in users.items[0]));
 const user=(await http.get(`/admin/v1/users/${guardian.userId}`).set('Authorization','Bearer support').expect(200)).body;
 assert.equal(user.id,guardian.userId);assert.ok(user.memberships.some((m:{householdId:string})=>m.householdId===household));assert.ok(user.dogs.some((d:{id:string})=>d.id===dogId));assert.ok(!JSON.stringify(user).includes('+919'));
 const dogs=(await http.get('/admin/v1/dogs?status=active&publicationState=draft').set('Authorization','Bearer support').expect(200)).body;
 assert.ok(dogs.items.some((d:{id:string})=>d.id===dogId));
 const dog=(await http.get(`/admin/v1/dogs/${dogId}`).set('Authorization','Bearer support').expect(200)).body;
 assert.equal(dog.id,dogId);assert.ok(dog.members.some((m:{userId:string})=>m.userId===guardian.userId));assert.ok(!('storageKey' in dog));assert.ok(!JSON.stringify(dog).includes('document_storage_key'));
 await http.get('/admin/v1/overview').set('Authorization','Bearer support').expect(403);
 const overview=(await http.get('/admin/v1/overview').set('Authorization','Bearer one').expect(200)).body;
 assert.ok(overview.users.total>=1);assert.ok(overview.dogs.total>=1);assert.equal(typeof overview.work.openReports,'number');
 const actions=(await f.database.query("SELECT action FROM ops.audit_log WHERE actor_kind='staff' AND action IN('users.list','user.directory.read','dogs.list','dog.read','overview.read')")).rows.map(r=>r.action);
 assert.deepEqual(new Set(actions),new Set(['users.list','user.directory.read','dogs.list','dog.read','overview.read']));
});
test('reviewed help articles remain private as drafts, publish immutably and can be retired',async()=>{
 const input={locale:'en-IN',slug:'meeting-safely',version:'v1',title:'Safe meeting guidance',body:'TEST FIXTURE GUIDANCE ONLY. Meet in a reviewed public place and keep control of your dog.',reviewReference:'TEST EDITORIAL REVIEW'};
 await http.post('/admin/v1/help/articles').set('Authorization','Bearer support').send(input).expect(403);
 const draft=(await http.post('/admin/v1/help/articles').set('Authorization','Bearer one').send(input).expect(201)).body;
 await http.get('/v1/help/articles?locale=en-IN').expect(200).then(r=>assert.equal(r.body.items.length,0));
 await http.get('/v1/help/articles/meeting-safely?locale=en-IN').expect(404);
 await http.post(`/admin/v1/help/articles/${draft.id}/publish`).set('Authorization','Bearer one').send({reviewConfirmed:false}).expect(400);
 await http.post(`/admin/v1/help/articles/${draft.id}/publish`).set('Authorization','Bearer one').send({reviewConfirmed:true}).expect(200);
 const publicArticle=(await http.get('/v1/help/articles/meeting-safely?locale=en-IN').expect(200)).body;assert.equal(publicArticle.body,input.body);assert.ok(!('reviewReference' in publicArticle));
 await assert.rejects(f.database.query('UPDATE ops.help_articles SET body=$2 WHERE id=$1',[draft.id,'Changed body']));
 await http.post('/admin/v1/help/articles').set('Authorization','Bearer one').send(input).expect(409);
 const replacement=(await http.post('/admin/v1/help/articles').set('Authorization','Bearer one').send({...input,version:'v2',body:'TEST UPDATED GUIDANCE ONLY. Meet in a public place and check current consent.'}).expect(201)).body;
 await http.post(`/admin/v1/help/articles/${replacement.id}/publish`).set('Authorization','Bearer one').send({reviewConfirmed:true}).expect(200);
 assert.equal((await http.get('/v1/help/articles?locale=en-IN').expect(200)).body.items.length,1);
 assert.equal((await http.get('/v1/help/articles/meeting-safely?locale=en-IN').expect(200)).body.version,'v2');
 await http.post(`/admin/v1/help/articles/${replacement.id}/retire`).set('Authorization','Bearer one').send({}).expect(200);
 await http.get('/v1/help/articles/meeting-safely?locale=en-IN').expect(404);
 assert.ok((await f.database.query("SELECT count(*)::int n FROM ops.audit_log WHERE subject_type='help_article'")).rows[0].n>=4);
});
