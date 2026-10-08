import { randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { migrate } from '../../src/db/migrate.js';
import type { PhotoStorage } from '../../src/modules/media/media.storage.js';

export function fixture(photoStorage?: PhotoStorage) {
  const connectionString=process.env.TEST_DATABASE_URL;
  if (!connectionString || !new URL(connectionString).pathname.endsWith('_test')) throw new Error('Use a dedicated TEST_DATABASE_URL ending in _test.');
  const database=new pg.Pool({connectionString,max:12});
  const codes=new Map<string,string>();
  const auth=new AuthService(database,randomBytes(48).toString('hex'),{async send(phone,code){codes.set(phone,code);}});
  let sequence=200000;
  return { database,app:createApp({database,auth,photoStorage}),
    async setup(){await migrate(database);await database.query('TRUNCATE identity.users,identity.otp_challenges,identity.households,identity.policy_documents CASCADE');},
    async close(){await database.end();},
    async user(){const phone=`+919000${sequence++}`;await auth.requestOtp(phone,'IN');const pair=await auth.verifyOtp({phoneE164:phone,code:codes.get(phone)!,deviceId:randomUUID(),displayName:'Test Guardian'});return {...pair,phone,header:`Bearer ${pair.accessToken}`};},
    async document(purpose:string,version='test-v1', published=true){
      const id=randomUUID();await database.query(`INSERT INTO identity.policy_documents(id,purpose,version,country_code,locale,body,published_at)
        VALUES ($1,$2,$3,'IN','en-IN','TEST FIXTURE ONLY - NOT LEGAL TEXT',CASE WHEN $4 THEN clock_timestamp() ELSE NULL END)`,[id,purpose,version,published]);return id;
    },
    async household(userId:string){const id=randomUUID(); const tx=await database.connect();
      try{await tx.query('BEGIN');await tx.query("INSERT INTO identity.households(id,name,geo_salt) VALUES ($1,'Test household',$2)",[id,randomBytes(32)]);
        await tx.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES ($1,$2,'owner',now())",[id,userId]);await tx.query('COMMIT');}
      catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}return id;
    },
    async dog(householdId:string){const id=randomUUID();await database.query(`INSERT INTO graph.dogs(id,household_id,name,sex,size_class,date_of_birth,neutered)
      VALUES ($1,$2,'Test Dog','female','medium','2023-01-01',true)`,[id,householdId]);return id;},
  };
}
