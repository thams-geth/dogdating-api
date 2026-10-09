import { notifyConversation } from '../notifications/notifications.events.js';
import { randomBytes,randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { socialLock } from '../../db/social-lock.js';
import { ApiError } from '../../middleware/error.js';
import { decodeCursor,page } from '../../http/pagination.js';
import { ConnectionsRepository } from '../connections/connections.repository.js';
import { open,seal,type MessageCipher } from './message-cipher.js';
import type { messageInput,historyQuery,conversationPreferences } from './messages.schemas.js';
export class MessagesService {
 private readonly connections=new ConnectionsRepository();
 constructor(private readonly db:Pool,private readonly cipher?:MessageCipher){}
 private configured(){if(!this.cipher)throw new ApiError(503,'messaging-unavailable','Message encryption is not configured.');return this.cipher;}
 async access(tx:PoolClient,userId:string,id:string){
  const c=(await tx.query('SELECT id,match_id,last_seq,state FROM meetup.conversations WHERE id=$1',[id])).rows[0];
  if(!c||c.state!=='open')throw new ApiError(404,'not-found','Conversation is unavailable.');
  await this.connections.match(tx,userId,c.match_id);return c;
 }
 private async key(tx:PoolClient,id:string){
  const cipher=this.configured();let row=(await tx.query('SELECT wrapped_key FROM meetup.conversation_keys WHERE conversation_id=$1',[id])).rows[0];
  if(!row){const key=randomBytes(32);row=(await tx.query('INSERT INTO meetup.conversation_keys(conversation_id,wrapped_key) VALUES($1,$2) RETURNING wrapped_key',[id,cipher.wrap(key,id)])).rows[0];}
  return cipher.unwrap(row.wrapped_key,id);
 }
 private decode(row:Record<string,any>,key:Buffer){return {id:row.message_id,clientMessageId:row.client_message_id,seq:row.seq,senderUserId:row.sender_user_id,kind:row.kind,body:row.deleted_at?null:open(key,row.body_encrypted,`${row.conversation_id}:${row.message_id}`).toString('utf8'),createdAt:row.created_at};}
 send(userId:string,id:string,input:z.infer<typeof messageInput>){return transaction(this.db,async tx=>{
  this.configured();await socialLock(tx);await this.access(tx,userId,id);
  const key=await this.key(tx,id);
  const existing=(await tx.query('SELECT * FROM meetup.messages WHERE conversation_id=$1 AND sender_user_id=$2 AND client_message_id=$3',[id,userId,input.clientMessageId])).rows[0];
  if(existing){const message=this.decode(existing,key);if(message.body!==input.body||message.kind!==input.kind)throw new ApiError(409,'message-id-conflict','Client message ID already has different content.');return message;}
  const count=(await tx.query("SELECT count(*)::int n FROM meetup.messages WHERE sender_user_id=$1 AND created_at>now()-interval '1 minute'",[userId])).rows[0].n;
  if(count>=30)throw new ApiError(429,'message-limit','Wait before sending more messages.');
  const seq=(await tx.query('UPDATE meetup.conversations SET last_seq=last_seq+1,last_message_at=now() WHERE id=$1 RETURNING last_seq',[id])).rows[0].last_seq;
  const messageId=randomUUID(),row=(await tx.query(`INSERT INTO meetup.messages(conversation_id,seq,message_id,sender_user_id,kind,body_encrypted,client_message_id) VALUES($1,$2,$3,$4,'text',$5,$6) RETURNING *`,[id,seq,messageId,userId,seal(key,Buffer.from(input.body),`${id}:${messageId}`),input.clientMessageId])).rows[0];
  await notifyConversation(tx,id,messageId,'messages',userId);
  await tx.query('UPDATE meetup.conversation_members SET archived=false WHERE conversation_id=$1',[id]);return this.decode(row,key);
 });}
 history(userId:string,id:string,input:z.infer<typeof historyQuery>){return transaction(this.db,async tx=>{
  this.configured();await socialLock(tx);const conversation=await this.access(tx,userId,id),key=await this.key(tx,id);
  const rows=(await tx.query(`SELECT * FROM meetup.messages WHERE conversation_id=$1 AND ($2::bigint IS NULL OR seq<$2) AND ($3::bigint IS NULL OR seq>$3) ORDER BY seq ${input.afterSeq?'ASC':'DESC'} LIMIT $4`,[id,input.beforeSeq??null,input.afterSeq??null,input.limit+1])).rows;
  return {messages:rows.slice(0,input.limit).map(row=>this.decode(row,key)),hasMore:rows.length>input.limit,lastSeq:conversation.last_seq};
 });}
 list(userId:string,limit:number,cursor?:string){return transaction(this.db,async tx=>{
  this.configured();await socialLock(tx);const scope=`conversations:${userId}`,after=decodeCursor(cursor,scope);
  const rows=(await tx.query(`SELECT c.id,c.match_id AS "matchId",c.last_seq AS "lastSeq",c.last_message_at AS "lastMessageAt",cm.last_read_seq AS "lastReadSeq",cm.archived,cm.muted_until AS "mutedUntil",
   (SELECT count(*)::int FROM meetup.messages msg WHERE msg.conversation_id=c.id AND msg.seq>cm.last_read_seq AND msg.sender_user_id<>$1 AND msg.deleted_at IS NULL) AS "unreadCount"
   FROM meetup.conversations c JOIN meetup.conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=$1 AND c.state='open' AND ($2::uuid IS NULL OR c.id>$2) ORDER BY c.id LIMIT $3`,[userId,after,limit+1])).rows;
  const result=page(rows,limit,scope),items=[];
  for(const row of result.items){try{await this.access(tx,userId,row.id);items.push(row);}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}}
  return {items,nextCursor:result.nextCursor};
 });}
 read(userId:string,id:string,upToSeq:string){return transaction(this.db,async tx=>{
  await socialLock(tx);const c=await this.access(tx,userId,id);
  if(BigInt(upToSeq)>BigInt(c.last_seq))throw new ApiError(400,'invalid-read-sequence','Read sequence exceeds conversation history.');
  const row=(await tx.query('UPDATE meetup.conversation_members SET last_read_seq=greatest(last_read_seq,$3) WHERE conversation_id=$1 AND user_id=$2 RETURNING last_read_seq AS "lastReadSeq"',[id,userId,upToSeq])).rows[0];return row;
 });}
 preferences(userId:string,id:string,input:z.infer<typeof conversationPreferences>){return transaction(this.db,async tx=>{
  await socialLock(tx);await this.access(tx,userId,id);
  if(input.mutedUntil&&new Date(input.mutedUntil).getTime()>Date.now()+365*86400000)throw new ApiError(400,'invalid-mute','Mute cannot exceed one year.');
  return (await tx.query(`UPDATE meetup.conversation_members SET archived=coalesce($3,archived),muted_until=CASE WHEN $4 THEN $5::timestamptz ELSE muted_until END WHERE conversation_id=$1 AND user_id=$2 RETURNING archived,muted_until AS "mutedUntil"`,[id,userId,input.archived??null,input.mutedUntil!==undefined,input.mutedUntil??null])).rows[0];
 });}
}
