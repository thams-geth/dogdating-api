import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
export interface MessageCipher { wrap(key:Buffer,context:string):Buffer; unwrap(value:Buffer,context:string):Buffer; }
export function seal(key:Buffer,body:Buffer,context:string){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(context));
 const encrypted=Buffer.concat([cipher.update(body),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]);
}
export function open(key:Buffer,value:Buffer,context:string){
 const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAAD(Buffer.from(context));decipher.setAuthTag(value.subarray(12,28));
 return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]);
}
// Development key wrapping only; production must inject an audited key management adapter.
export class LocalMessageCipher implements MessageCipher {
 private readonly key:Buffer;
 constructor(hex:string,environment:string){if(environment==='production'||!/^[a-f0-9]{64}$/.test(hex))throw new Error('Local message encryption requires a 32-byte hex key and non-production environment.');this.key=Buffer.from(hex,'hex');}
 wrap(key:Buffer,context:string){return seal(this.key,key,context);}
 unwrap(value:Buffer,context:string){return open(this.key,value,context);}
}
