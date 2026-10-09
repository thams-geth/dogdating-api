import { z } from 'zod';import { pool } from '../../db/pool.js';import { transaction } from '../../db/transaction.js';
const input=z.tuple([z.string().url().startsWith('https://'),z.string().min(1).max(255),z.string().transform(s=>s.split(',')).pipe(z.array(z.enum(['moderator','support','appeals','city_ops','operations','reviewer','release_ops','legal_ops'])).min(1))]);
try{
 const [issuer,subject,roles]=input.parse(process.argv.slice(2));
 const result=await transaction(pool,async tx=>{
  const row=(await tx.query('INSERT INTO ops.staff_accounts(issuer,subject,roles) VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO UPDATE SET roles=$3,active=true RETURNING id',[issuer,subject,roles])).rows[0];
  await tx.query("INSERT INTO ops.audit_log(actor_kind,action,subject_type,subject_id) VALUES('system','staff.provision','staff',$1)",[row.id]);return row;
 });console.log(JSON.stringify({event:'staff.provisioned',id:result.id}));
}catch{console.error('Provisioning failed. Usage: npm run staff:provision -- <https-issuer> <OIDC-subject> <comma-separated-roles>');process.exitCode=1;}finally{await pool.end();}
