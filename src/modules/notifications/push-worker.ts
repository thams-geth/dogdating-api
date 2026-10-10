import { randomUUID } from 'node:crypto';import type { Pool } from 'pg';
import { transaction } from '../../db/transaction.js';import { socialLock } from '../../db/social-lock.js';import { ApiError } from '../../middleware/error.js';
import { ConnectionsRepository } from '../connections/connections.repository.js';import type { MessageCipher } from '../messages/message-cipher.js';
export type PushResult={status:'delivered'|'invalid_token'|'transient_failure'|'permanent_failure';retryAfterSeconds?:number};
export interface PushProvider {
 supports(provider:string):boolean;
 // Adapter must honor abort and include deliveryId so clients can deduplicate retries.
 send(input:{provider:string;token:string;deliveryId:string;payload:{notificationId:string;category:string;title:'Waggle update'};signal:AbortSignal}):Promise<PushResult>;
}
function quiet(preference:Record<string,any>){
 if(preference.quiet_start===null||preference.quiet_start===undefined||preference.quiet_start===preference.quiet_end)return false;
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:preference.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
 const minutes=Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value),start=preference.quiet_start,end=preference.quiet_end;
 return start<end?minutes>=start&&minutes<end:minutes>=start||minutes<end;
}
async function prepare(db:Pool,id:string){return transaction(db,async tx=>{
 await socialLock(tx);
 const notification=(await tx.query(`SELECT n.*,c.match_id,cm.muted_until,u.status,u.deleted_at,u.deletion_requested_at FROM identity.notifications n JOIN meetup.conversations c ON c.id=n.conversation_id JOIN meetup.conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=n.user_id JOIN identity.users u ON u.id=n.user_id WHERE n.id=$1`,[id])).rows[0];
 if(!notification||notification.read_at||notification.deleted_at||notification.deletion_requested_at||!['active','pending'].includes(notification.status))return {state:'suppress' as const};
 try{await new ConnectionsRepository().match(tx,notification.user_id,notification.match_id);}catch(e){if(e instanceof ApiError&&e.status===404)return {state:'suppress' as const};throw e;}
 const preference=(await tx.query('SELECT * FROM identity.notification_preferences WHERE user_id=$1',[notification.user_id])).rows[0];
 if(!preference?.push_enabled||!preference[notification.category]||(notification.category==='messages'&&notification.muted_until&&notification.muted_until>new Date()))return {state:'suppress' as const};
 if(quiet(preference))return {state:'quiet' as const};
 const devices=(await tx.query(`SELECT d.installation_id,d.provider,d.token_hash,d.token_encrypted FROM identity.devices d WHERE d.user_id=$1
  AND EXISTS(SELECT 1 FROM identity.sessions s WHERE s.family_id=d.family_id AND s.user_id=d.user_id AND s.revoked_at IS NULL AND s.expires_at>now())
  AND NOT EXISTS(SELECT 1 FROM ops.push_delivery_receipts receipt WHERE receipt.notification_id=$2 AND receipt.installation_id=d.installation_id)
  ORDER BY d.installation_id`,[notification.user_id,id])).rows;
 return {state:'deliver' as const,notification,devices};
 });}
async function timedSend(provider:PushProvider,input:Omit<Parameters<PushProvider['send']>[0],'signal'>):Promise<PushResult>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([provider.send({...input,signal:controller.signal}),new Promise<PushResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:'transient_failure'});},5000);})]);}
 catch{return {status:'transient_failure'};}finally{if(timer)clearTimeout(timer);}
}
export async function deliverPushBatch(db:Pool,cipher:MessageCipher,provider?:PushProvider,limit=10){
 const summary={claimed:0,delivered:0,suppressed:0,deferred:0,retrying:0,deadLetter:0,providerAvailable:!!provider};if(!provider)return summary;
 for(let i=0;i<Math.min(10,Math.max(0,limit));i++){
  const lease=randomUUID();const job=await transaction(db,async tx=>{
   const row=(await tx.query("SELECT notification_id,attempts FROM ops.push_jobs WHERE state IN('awaiting_provider','pending') AND available_at<=now() AND (lease_until IS NULL OR lease_until<=now()) ORDER BY available_at,notification_id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];if(!row)return null;
   await tx.query("UPDATE ops.push_jobs SET state='pending',lease_token=$2,lease_until=now()+interval '2 minutes',attempts=attempts+1 WHERE notification_id=$1",[row.notification_id,lease]);return {...row,attempts:row.attempts+1};
  });if(!job)break;summary.claimed++;
  const finish=async(state:string,code:string|null,delaySeconds=0,refund=false)=>db.query(`UPDATE ops.push_jobs SET state=$3,last_error=$4,available_at=now()+$5*interval '1 second',lease_token=NULL,lease_until=NULL,attempts=attempts-CASE WHEN $6 THEN 1 ELSE 0 END WHERE notification_id=$1 AND lease_token=$2`,[job.notification_id,lease,state,code,delaySeconds,refund]);
  try{
   let prepared=await prepare(db,job.notification_id);
   if(prepared.state==='suppress'){await finish('suppressed',null);summary.suppressed++;continue;}
   if(prepared.state==='quiet'){await finish('pending','quiet_hours',900,true);summary.deferred++;continue;}
   const candidates=prepared.devices.filter(d=>provider.supports(d.provider));
   if(!candidates.length&&prepared.devices.length){await finish('awaiting_provider','unsupported_provider',3600,true);summary.deferred++;continue;}
   if(!candidates.length){const receipt=(await db.query('SELECT 1 FROM ops.push_delivery_receipts WHERE notification_id=$1 LIMIT 1',[job.notification_id])).rowCount;await finish(receipt?'delivered':'suppressed',null);receipt?summary.delivered++:summary.suppressed++;continue;}
   let transient=false,permanent=false,delivered=false,suppressed=false,deferred=false,retryAfterSeconds=0;
   for(const candidate of candidates){
    if(!(await db.query('SELECT 1 FROM ops.push_jobs WHERE notification_id=$1 AND lease_token=$2 AND lease_until>now()',[job.notification_id,lease])).rowCount)break;
    prepared=await prepare(db,job.notification_id);if(prepared.state==='suppress'){suppressed=true;break;}if(prepared.state==='quiet'){deferred=true;break;}
    const device=prepared.devices.find(d=>d.installation_id===candidate.installation_id&&d.token_hash===candidate.token_hash);if(!device){if(prepared.devices.some(d=>d.installation_id===candidate.installation_id))transient=true;continue;}
    const result=await timedSend(provider,{provider:device.provider,token:cipher.unwrap(device.token_encrypted,`device:${device.installation_id}`).toString('utf8'),deliveryId:`${job.notification_id}:${device.installation_id}`,payload:{notificationId:job.notification_id,category:prepared.notification.category,title:'Waggle update'}});
    if(result.status==='delivered'){
     await db.query('INSERT INTO ops.push_delivery_receipts(notification_id,installation_id) SELECT id,$2::uuid FROM identity.notifications WHERE id=$1 ON CONFLICT DO NOTHING',[job.notification_id,device.installation_id]);delivered=true;
    }else if(result.status==='invalid_token')await db.query('DELETE FROM identity.devices WHERE installation_id=$1 AND token_hash=$2',[device.installation_id,device.token_hash]);
    else if(result.status==='permanent_failure')permanent=true;else {transient=true;const hint=result.retryAfterSeconds;retryAfterSeconds=Math.max(retryAfterSeconds,Number.isFinite(hint)?Math.min(3600,Math.max(0,Math.ceil(hint!))):0);}
   }
   if(suppressed){await finish('suppressed',null);summary.suppressed++;}
   else if(deferred){await finish('pending','quiet_hours',900,true);summary.deferred++;}
   else if(permanent||transient&&job.attempts>=5){await finish('dead_letter',permanent?'provider_rejected':'retries_exhausted');summary.deadLetter++;}
   else if(transient){await finish('pending','provider_retry',Math.max(Math.min(3600,30*2**(job.attempts-1)),retryAfterSeconds));summary.retrying++;}
   else if(prepared.state==='deliver'&&prepared.devices.some(d=>!provider.supports(d.provider))){await finish('awaiting_provider','unsupported_provider',3600,true);summary.deferred++;}
   else {await finish(delivered?'delivered':'suppressed',null);delivered?summary.delivered++:summary.suppressed++;}
  }catch{
   if(job.attempts>=5){await finish('dead_letter','processing_failed');summary.deadLetter++;}
   else{await finish('pending','processing_retry',Math.min(3600,30*2**(job.attempts-1)));summary.retrying++;}
  }
 }
 return summary;
}
