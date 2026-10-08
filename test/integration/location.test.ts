import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { fixture } from '../support/fixture.js';
const f = fixture(), http = request(f.app), ids: string[] = [];
before(() => f.setup()); after(async () => { await f.database.query('UPDATE identity.households SET metro_id=NULL WHERE metro_id=ANY($1::uuid[])', [ids]); await f.database.query('DELETE FROM ops.metros WHERE id=ANY($1::uuid[])', [ids]); await f.close(); });
async function area(state = 'seeding', country = 'IN') {
  const id = randomUUID(); ids.push(id);
  await f.database.query("INSERT INTO ops.metros(id,name,country,launch_state) VALUES ($1,'TEST LOCATION AREA',$2,$3)", [id,country,state]); return id;
}
async function setup() {
  const user = await f.user(), household = await f.household(user.userId), dog = await f.dog(household);
  const doc = await f.document('location', randomUUID());
  await http.post('/v1/me/consents').set('Authorization',user.header).send({documentId:doc}).expect(200);
  return {user,household,dog};
}
function put(header: string, household: string, areaId: string) { return http.put(`/v1/households/${household}/location`).set('Authorization',header).send({source:'manual_area',areaId}); }

test('public area list has honest rollout, bounded pagination, literal search and filter-scoped cursors', async () => {
  await area(); await area('waitlist'); const hidden = await area('prospect');
  const first = await http.get('/v1/app/areas').query({countryCode:'IN',query:'TEST LOCATION',limit:1}).expect(200);
  assert.equal(first.body.areas.length,1); assert.ok(first.body.nextCursor);
  const all = await http.get('/v1/app/areas').query({query:'TEST LOCATION'}).expect(200);
  assert.ok(!all.body.areas.some((a:{id:string})=>a.id===hidden));
  assert.ok(all.body.areas.some((a:{rollout:string;selectable:boolean})=>a.rollout==='development' && a.selectable));
  assert.ok(all.body.areas.some((a:{rollout:string;selectable:boolean})=>a.rollout==='waitlist' && !a.selectable));
  assert.ok(!JSON.stringify(all.body).includes('metro_cells')); assert.ok(!JSON.stringify(all.body).includes('active_dog_count'));
  await http.get('/v1/app/areas').query({query:'changed',cursor:first.body.nextCursor}).expect(400);
  assert.equal((await http.get('/v1/app/areas').query({query:'%'}).expect(200)).body.areas.length,0);
  await http.get('/v1/app/areas?countryCode=in').expect(400); await http.get('/v1/app/areas?limit=51').expect(400);
});

test('location requires current consent; manual selection stores no GPS and is idempotent', async () => {
  const user=await f.user(), household=await f.household(user.userId), selected=await area();
  await put(user.header,household,selected).expect(409);
  const doc=await f.document('location',randomUUID()); await http.post('/v1/me/consents').set('Authorization',user.header).send({documentId:doc}).expect(200);
  const response=await put(user.header,household,selected).expect(200);
  assert.equal(response.body.precision,'city'); assert.equal(response.body.source,'manual_area'); assert.equal(response.body.area.id,selected);
  const again=await put(user.header,household,selected).expect(200); assert.equal(again.body.canChangeAt,response.body.canChangeAt);
  const row=(await f.database.query('SELECT cell_coarse,cell_fine,anchor_origin_lat,anchor_origin_lon FROM identity.households WHERE id=$1',[household])).rows[0];
  assert.deepEqual(Object.values(row),[null,null,null,null]);
  for(const key of ['cell_coarse','geo_salt','latitude','longitude']) assert.ok(!JSON.stringify(response.body).includes(key));
  await http.put(`/v1/households/${household}/location`).set('Authorization',user.header).send({source:'manual_area',areaId:selected,latitude:12}).expect(400);
  await f.document('location',randomUUID()); await put(user.header,household,selected).expect(409);
});

test('location access checks current household roles and areas in the account country', async () => {
  const {user,household}=await setup(), member=await f.user(), stranger=await f.user(), selected=await area();
  await http.get(`/v1/households/${household}/location`).set('Authorization',stranger.header).expect(404);
  await put(stranger.header,household,selected).expect(404);
  await f.database.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES ($1,$2,'view_only',now())",[household,member.userId]);
  await http.get(`/v1/households/${household}/location`).set('Authorization',member.header).expect(200);
  await put(member.header,household,selected).expect(403);
  await http.delete(`/v1/households/${household}/location`).set('Authorization',member.header).expect(403);
  for(const id of [await area('waitlist'),await area('open','US'),randomUUID()]) await put(user.header,household,id).expect(409);
  await f.database.query('DELETE FROM identity.household_members WHERE household_id=$1 AND user_id=$2',[household,member.userId]);
  await http.get(`/v1/households/${household}/location`).set('Authorization',member.header).expect(404);
});

test('concurrent changes serialize; deleting never bypasses the change deadline', async () => {
  const {user,household}=await setup(), a=await area(), b=await area();
  const results=await Promise.all([put(user.header,household,a),put(user.header,household,b)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,429]);
  for(let i=0;i<2;i++) await http.delete(`/v1/households/${household}/location`).set('Authorization',user.header).expect(204);
  const empty=await http.get(`/v1/households/${household}/location`).set('Authorization',user.header).expect(200);
  assert.equal(empty.body.area,null); assert.ok(empty.body.canChangeAt);
  await put(user.header,household,a).expect(429);
  await f.database.query("UPDATE identity.households SET location_change_after=now()-interval '1 second' WHERE id=$1",[household]);
  await put(user.header,household,a).expect(200);
});

test('location updates/reset affect household publication, beacons and live onboarding readiness', async () => {
  const {user,household,dog}=await setup(), selected=await area();
  await http.put('/v1/me/active-dog').set('Authorization',user.header).send({dogId:dog}).expect(200);
  await f.database.query("UPDATE graph.dogs SET publication_state='published' WHERE id=$1",[dog]);
  await f.database.query("INSERT INTO graph.dog_availability(id,dog_id,beacon_until) VALUES ($1,$2,now()+interval '1 hour')",[randomUUID(),dog]);
  await put(user.header,household,selected).expect(200);
  assert.equal((await f.database.query('SELECT publication_state FROM graph.dogs WHERE id=$1',[dog])).rows[0].publication_state,'draft');
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM graph.dog_availability WHERE dog_id=$1',[dog])).rows[0].n,0);
  assert.ok(!(await http.get('/v1/me/onboarding').set('Authorization',user.header).expect(200)).body.missing.includes('location'));
  await f.database.query("UPDATE ops.metros SET launch_state='gated' WHERE id=$1",[selected]);
  assert.ok((await http.get('/v1/me/onboarding').set('Authorization',user.header).expect(200)).body.missing.includes('location'));
  await f.database.query("UPDATE ops.metros SET launch_state='seeding' WHERE id=$1",[selected]);
  await http.delete('/v1/me/consents/location').set('Authorization',user.header).expect(204);
  assert.ok((await http.get('/v1/me/onboarding').set('Authorization',user.header).expect(200)).body.missing.includes('location'));
  // Consent withdrawal is per guardian; household data has a separate explicit removal action.
  await http.delete(`/v1/households/${household}/location`).set('Authorization',user.header).expect(204);
  assert.equal((await http.get(`/v1/households/${household}/location`).set('Authorization',user.header).expect(200)).body.area,null);
});
