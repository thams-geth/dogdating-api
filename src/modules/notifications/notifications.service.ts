import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { z } from 'zod';
import type { Principal } from '../auth/auth.service.js';
import type { MessageCipher } from '../messages/message-cipher.js';
import { ConnectionsRepository } from '../connections/connections.repository.js';
import { transaction } from '../../db/transaction.js';
import { socialLock } from '../../db/social-lock.js';
import { decodeCursor,page } from '../../http/pagination.js';
import { ApiError } from '../../middleware/error.js';
import type { deviceInput,preferencesInput } from './notifications.schemas.js';
export class NotificationsService {
 private readonly connections=new ConnectionsRepository();
 constructor(private readonly db:Pool,private readonly cipher?:MessageCipher){}
 preferences(userId:string){return transaction(this.db,async tx=>{
  await tx.query('INSERT INTO identity.notification_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
  return (await tx.query(`SELECT messages,connections,meetups,push_enabled AS "pushEnabled",timezone,quiet_start AS "quietStart",quiet_end AS "quietEnd",false AS "pushAvailable" FROM identity.notification_preferences WHERE user_id=$1`,[userId])).rows[0];
 });}
 async savePreferences(userId:string,input:z.infer<typeof preferencesInput>){
  await this.db.query(`INSERT INTO identity.notification_preferences(user_id,messages,connections,meetups,push_enabled,timezone,quiet_start,quiet_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id) DO UPDATE SET messages=$2,connections=$3,meetups=$4,push_enabled=$5,timezone=$6,quiet_start=$7,quiet_end=$8`,[userId,input.messages,input.connections,input.meetups,input.pushEnabled,input.timezone,input.quietStart,input.quietEnd]);return this.preferences(userId);
 }
 register(p:Principal,id:string,input:z.infer<typeof deviceInput>){return transaction(this.db,async tx=>{
  if(!this.cipher)throw new ApiError(503,'device-storage-unavailable','Private device token storage is not configured.');
  await socialLock(tx);
  const session=(await tx.query('SELECT device_id FROM identity.sessions WHERE id=$1 AND user_id=$2',[p.sessionId,p.userId])).rows[0];
  if(session?.device_id!==id)throw new ApiError(403,'installation-mismatch','Use the installation ID from this sign-in.');
  await tx.query('DELETE FROM identity.devices d WHERE NOT EXISTS(SELECT 1 FROM identity.sessions s WHERE s.family_id=d.family_id AND s.revoked_at IS NULL AND s.expires_at>now())');
  const count=(await tx.query('SELECT count(*)::int n FROM identity.devices WHERE user_id=$1 AND installation_id<>$2',[p.userId,id])).rows[0].n;
  if(count>=10)throw new ApiError(409,'device-limit','Remove a device before adding another.');
  const tokenHash=createHash('sha256').update(input.token).digest('hex');
  await tx.query('DELETE FROM identity.devices WHERE token_hash=$1 AND installation_id<>$2',[tokenHash,id]);
  await tx.query(`INSERT INTO identity.devices(installation_id,user_id,family_id,platform,provider,token_hash,token_encrypted,locale,app_build) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT(installation_id) DO UPDATE SET user_id=$2,family_id=$3,platform=$4,provider=$5,token_hash=$6,token_encrypted=$7,locale=$8,app_build=$9,updated_at=now()`,[id,p.userId,p.familyId,input.platform,input.provider,tokenHash,this.cipher.wrap(Buffer.from(input.token),`device:${id}`),input.locale,input.appBuild]);
  return {installationId:id,registered:true,pushAvailable:false};
 });}
 async remove(userId:string,id:string){await this.db.query('DELETE FROM identity.devices WHERE installation_id=$1 AND user_id=$2',[id,userId]);}
 list(userId:string,limit:number,cursor?:string){return transaction(this.db,async tx=>{
  await socialLock(tx);const scope=`notifications:${userId}`,after=decodeCursor(cursor,scope);
  const rows=(await tx.query(`SELECT n.id,n.category,n.conversation_id AS "conversationId",c.match_id AS "matchId",n.created_at AS "createdAt",n.read_at AS "readAt" FROM identity.notifications n JOIN meetup.conversations c ON c.id=n.conversation_id WHERE n.user_id=$1 AND ($2::uuid IS NULL OR n.id>$2) ORDER BY n.id LIMIT $3`,[userId,after,limit+1])).rows;
  const result=page(rows,limit,scope),items=[];
  for(const row of result.items){try{await this.connections.match(tx,userId,row.matchId);items.push(row);}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}}
  return {items,nextCursor:result.nextCursor};
 });}
 async read(userId:string,ids:string[]){await this.db.query('UPDATE identity.notifications SET read_at=coalesce(read_at,now()) WHERE user_id=$1 AND id=ANY($2::uuid[])',[userId,ids]);}
}
