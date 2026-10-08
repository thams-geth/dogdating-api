import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../middleware/error.js';
const tokenSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('cursor'),userId:z.string().uuid(),dogId:z.string().uuid(),sessionId:z.string().uuid(),offset:z.number().int().min(0).max(200),exp:z.number().int()}).strict(),
  z.object({kind:z.literal('impression'),userId:z.string().uuid(),dogId:z.string().uuid(),targetId:z.string().uuid(),mode:z.literal('pack'),exp:z.number().int()}).strict(),
]);
type Payload=z.infer<typeof tokenSchema>;
export class DiscoveryTokens {
  constructor(private readonly secret:string){if(secret.length<64)throw new Error('Discovery signing secret must contain at least 64 characters.');}
  private signature(payload:string){return createHmac('sha256',this.secret).update(`waggle.discovery.v1:${payload}`).digest('base64url');}
  sign(payload:Payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return `${body}.${this.signature(body)}`;}
  verify(token:string):Payload{
    let payload:Payload;
    try{
      if(token.length>2048||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw new Error();
      const [body,signature]=token.split('.');const expected=Buffer.from(this.signature(body!)),actual=Buffer.from(signature!);
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();
      payload=tokenSchema.parse(JSON.parse(Buffer.from(body!,'base64url').toString('utf8')));
    }catch{throw new ApiError(400,'invalid-discovery-token','Discovery token is invalid; restart the feed.');}
    if(payload.exp<=Math.floor(Date.now()/1000))throw new ApiError(410,'discovery-token-expired','Discovery token expired; restart the feed.');
    return payload;
  }
}
