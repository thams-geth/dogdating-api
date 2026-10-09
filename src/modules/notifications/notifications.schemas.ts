import { z } from 'zod';
const timezone=z.string().max(80).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}});
export const preferencesInput=z.object({messages:z.boolean(),connections:z.boolean(),meetups:z.boolean(),pushEnabled:z.boolean(),timezone,
 quietStart:z.number().int().min(0).max(1439).nullable(),quietEnd:z.number().int().min(0).max(1439).nullable()}).strict().refine(v=>(v.quietStart===null)===(v.quietEnd===null));
export const deviceInput=z.object({platform:z.enum(['android','ios','web']),provider:z.enum(['fcm','apns','webpush']),token:z.string().min(16).max(4096),locale:z.enum(['en-IN','hi-IN']),appBuild:z.number().int().positive().max(2147483647)}).strict().refine(v=>v.platform==='android'?v.provider==='fcm':v.platform==='ios'?['fcm','apns'].includes(v.provider):v.provider==='webpush');
export const notificationRead=z.object({ids:z.array(z.string().uuid()).min(1).max(100).refine(v=>new Set(v).size===v.length)}).strict();
