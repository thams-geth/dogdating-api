import { createHash,randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { WebSocketServer,WebSocket } from 'ws';
import { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import type { Principal } from '../auth/auth.service.js';
import type { MessagesService } from './messages.service.js';
import { messageInput,readInput } from './messages.schemas.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export class RealtimeService {
 constructor(private readonly db:Pool,readonly messages:MessagesService){}
 ticket(p:Principal){return transaction(this.db,async tx=>{
  await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[p.userId]);
  const n=(await tx.query("SELECT count(*)::int n FROM meetup.realtime_tickets WHERE user_id=$1 AND created_at>now()-interval '1 minute'",[p.userId])).rows[0].n;
  if(n>=10)throw new ApiError(429,'ticket-limit','Wait before requesting another socket ticket.');
  const ticket=randomBytes(32).toString('base64url');const row=(await tx.query('INSERT INTO meetup.realtime_tickets(token_hash,user_id,session_id) VALUES($1,$2,$3) RETURNING expires_at',[hash(ticket),p.userId,p.sessionId])).rows[0];
  return {ticket,expiresAt:row.expires_at,path:'/v1/realtime',authentication:'first_frame'};
 });}
 async consume(ticket:string){
  const row=(await this.db.query(`UPDATE meetup.realtime_tickets SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING user_id AS "userId",session_id AS "sessionId"`,[hash(ticket)])).rows[0];
  if(!row||!await this.valid(row))throw new ApiError(401,'invalid-ticket','Socket ticket is unavailable.');return row as {userId:string;sessionId:string};
 }
 async valid(p:{userId:string;sessionId:string}){return !!(await this.db.query(`SELECT 1 FROM identity.sessions s JOIN identity.users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status IN ('active','pending') AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL`,[p.sessionId,p.userId])).rowCount;}
}
const frame=z.discriminatedUnion('type',[
 z.object({type:z.literal('authenticate'),ticket:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict(),
 z.object({type:z.literal('subscribe'),conversationId:z.string().uuid(),afterSeq:z.string().regex(/^(0|[1-9][0-9]{0,18})$/)}).strict(),
 z.object({type:z.literal('send'),conversationId:z.string().uuid(),message:messageInput}).strict(),
 z.object({type:z.literal('read'),conversationId:z.string().uuid(),...readInput.shape}).strict(),
]);
// DB-backed catch-up works across instances; bounded polling is deliberate for development.
export function attachRealtime(server:Server,service:RealtimeService){
 const wss=new WebSocketServer({noServer:true,maxPayload:20*1024,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/v1/realtime'||wss.clients.size>=200){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
 });
 wss.on('connection',ws=>{
  let principal:{userId:string;sessionId:string}|undefined,busy=false,subscription:{id:string;seq:string}|undefined;
  const send=(value:unknown)=>{if(ws.bufferedAmount>256*1024){ws.close(1013,'Reconnect and recover history');return;}if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value));};
  const deadline=setTimeout(()=>{if(!principal)ws.close(1008,'Authenticate first');},5000);
  const lifetime=setTimeout(()=>ws.close(1000,'Refresh ticket'),15*60*1000);
  async function sync(){if(!principal||!subscription)return;
   if(!await service.valid(principal)){ws.close(1008,'Session ended');return;}
   const result=await service.messages.history(principal.userId,subscription.id,{...(subscription.seq==='0'?{afterSeq:'0'}:{afterSeq:subscription.seq}),limit:50});
   for(const message of result.messages){send({type:'message.created',conversationId:subscription.id,message});subscription.seq=message.seq;}
   if(result.hasMore)send({type:'sync.required',conversationId:subscription.id,afterSeq:subscription.seq});
  }
  const timer=setInterval(()=>{if(busy||!principal)return;busy=true;void (async()=>{if(!await service.valid(principal)){ws.close(1008,'Session ended');return;}await sync();})().catch(()=>ws.close(1008,'Subscription unavailable')).finally(()=>{busy=false;});},2000);
  ws.on('message',(data,isBinary)=>{
   if(busy){send({type:'error',code:'socket-busy'});return;}busy=true;
   void (async()=>{
    if(isBinary)throw new Error();const input=frame.parse(JSON.parse(data.toString()));
    if(!principal){if(input.type!=='authenticate')throw new Error();principal=await service.consume(input.ticket);clearTimeout(deadline);send({type:'ready',recovery:'REST',connectionLifetimeSeconds:900});return;}
    if(!await service.valid(principal))throw new Error();
    if(input.type==='subscribe'){subscription={id:input.conversationId,seq:input.afterSeq};await sync();send({type:'subscribed',conversationId:input.conversationId});}
    else if(input.type==='send')send({type:'message.ack',conversationId:input.conversationId,message:await service.messages.send(principal.userId,input.conversationId,input.message)});
    else if(input.type==='read')send({type:'read.updated',conversationId:input.conversationId,...await service.messages.read(principal.userId,input.conversationId,input.upToSeq)});
    else throw new Error();
   })().catch(error=>{if(error instanceof ApiError)send({type:'error',code:error.code,status:error.status});else ws.close(1008,'Invalid socket request');}).finally(()=>{busy=false;});
  });
  ws.on('error',()=>{});ws.on('close',()=>{clearTimeout(deadline);clearTimeout(lifetime);clearInterval(timer);});
 });
 server.on('close',()=>{for(const ws of wss.clients)ws.terminate();wss.close();});return wss;
}
