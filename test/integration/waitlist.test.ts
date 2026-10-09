import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import request from 'supertest';import { fixture } from '../support/fixture.js';
const f=fixture(),http=request(f.app),metroId='01920000-0000-7000-8000-0000000e0001';beforeEach(()=>f.setup());after(()=>f.close());
test('waitlist is opt-in, private, idempotent and restricted to accepting areas',async()=>{
 const a=await f.user(),b=await f.user();await http.post('/v1/waitlist').send({metroId}).expect(401);
 const first=(await http.post('/v1/waitlist').set('Authorization',a.header).send({metroId}).expect(201)).body;
 assert.equal(first.notificationDelivery,'unavailable');assert.equal((await http.post('/v1/waitlist').set('Authorization',a.header).send({metroId})).body.id,first.id);
 assert.equal((await http.get('/v1/waitlist').set('Authorization',b.header)).body.items.length,0);
 await http.delete(`/v1/waitlist/${first.id}`).set('Authorization',b.header).expect(204);assert.equal((await http.get('/v1/waitlist').set('Authorization',a.header)).body.items.length,1);
 await http.delete(`/v1/waitlist/${first.id}`).set('Authorization',a.header).expect(204);
 await http.post('/v1/waitlist').set('Authorization',a.header).send({metroId:'00000000-0000-4000-8000-000000000001'}).expect(409);
});
