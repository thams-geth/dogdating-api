import { createRemoteJWKSet,jwtVerify } from 'jose';import type { Pool } from 'pg';
import { ApiError } from '../../middleware/error.js';
export type StaffRole='moderator'|'support'|'appeals'|'city_ops'|'operations'|'reviewer';
export interface StaffIdentity {issuer:string;subject:string;mfa:boolean;authenticatedAt:number;}
export interface StaffVerifier {verify(token:string):Promise<StaffIdentity>;}
export interface StaffPrincipal {id:string;roles:StaffRole[];}
export class OidcStaffVerifier implements StaffVerifier {
 private readonly keys:ReturnType<typeof createRemoteJWKSet>;
 constructor(private readonly issuer:string,jwksUrl:string,private readonly audience:string){if(!issuer.startsWith('https://')||!jwksUrl.startsWith('https://'))throw new Error('Staff identity requires HTTPS.');this.keys=createRemoteJWKSet(new URL(jwksUrl));}
 async verify(token:string){const {payload}=await jwtVerify(token,this.keys,{issuer:this.issuer,audience:this.audience,algorithms:['RS256','ES256'],requiredClaims:['sub','exp','iat','auth_time','amr']});return {issuer:this.issuer,subject:payload.sub!,mfa:Array.isArray(payload.amr)&&payload.amr.includes('mfa'),authenticatedAt:Number(payload.auth_time)};}
}
export class StaffAuth {
 constructor(private readonly db:Pool,private readonly verifier?:StaffVerifier){}
 async authenticate(token:string):Promise<StaffPrincipal>{
  if(!this.verifier)throw new ApiError(503,'staff-auth-unavailable','Staff SSO is not configured.');
  let identity:StaffIdentity;try{identity=await this.verifier.verify(token);}catch{throw new ApiError(401,'staff-unauthenticated','A valid staff SSO token is required.');}
  const now=Date.now()/1000;if(!identity.mfa||!Number.isFinite(identity.authenticatedAt)||identity.authenticatedAt<now-900||identity.authenticatedAt>now+30)throw new ApiError(401,'staff-reauthentication-required','Recent staff MFA is required.');
  const row=(await this.db.query('SELECT id,roles FROM ops.staff_accounts WHERE issuer=$1 AND subject=$2 AND active',[identity.issuer,identity.subject])).rows[0];
  if(!row)throw new ApiError(403,'staff-forbidden','Staff access is not provisioned.');return row;
 }
}
