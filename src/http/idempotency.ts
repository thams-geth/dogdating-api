import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError } from '../middleware/error.js';
export const bodyHash=(body:unknown)=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
export async function receipt(tx:PoolClient,userId:string,operation:string,key:string,hash:string){
 const row=(await tx.query('SELECT body_hash,response FROM ops.api_receipts WHERE user_id=$1 AND operation=$2 AND key=$3',[userId,operation,key])).rows[0];
 if(row&&row.body_hash!==hash)throw new ApiError(409,'idempotency-conflict','This key was already used with different input.');
 return row?.response;
}
export async function saveReceipt(tx:PoolClient,userId:string,operation:string,key:string,hash:string,response:unknown){
 await tx.query('INSERT INTO ops.api_receipts(user_id,operation,key,body_hash,response) VALUES ($1,$2,$3,$4,$5)',[userId,operation,key,hash,JSON.stringify(response)]);
}
