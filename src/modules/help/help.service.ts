import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { page,decodeCursor } from '../../http/pagination.js';
import type { StaffPrincipal } from '../admin/staff-auth.js';
export const articleInput=z.object({locale:z.literal('en-IN'),slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),version:z.string().trim().min(1).max(60),title:z.string().trim().min(3).max(120),body:z.string().trim().min(30).max(10000),reviewReference:z.string().trim().min(5).max(200)}).strict();
const article=`id,locale,slug,version,title,body,state,created_at AS "createdAt",published_at AS "publishedAt",retired_at AS "retiredAt"`;
const summary=`id,locale,slug,version,title,published_at AS "publishedAt"`;
export class HelpService {
 constructor(private readonly db:Pool){}
 private audit(tx:PoolClient,staff:StaffPrincipal,action:string,id?:string){return tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES($1,'staff',$2,'help_article',$3)",[staff.id,action,id??null]);}
 publicList(limit:number,cursor?:string){const scope='help:en-IN',after=decodeCursor(cursor,scope);return this.db.query(`SELECT ${summary} FROM ops.help_articles WHERE state='published' AND locale='en-IN' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,[after,limit+1]).then(r=>page(r.rows,limit,scope));}
 async publicArticle(slug:string){const row=(await this.db.query(`SELECT ${article} FROM ops.help_articles WHERE locale='en-IN' AND slug=$1 AND state='published'`,[slug])).rows[0];if(!row)throw new ApiError(404,'not-found','Help article is unavailable.');return row;}
 list(staff:StaffPrincipal,limit:number,cursor?:string){return transaction(this.db,async tx=>{const scope='admin:help',after=decodeCursor(cursor,scope);await this.audit(tx,staff,'help.list');return page((await tx.query(`SELECT id,locale,slug,version,title,state,created_at AS "createdAt",published_at AS "publishedAt" FROM ops.help_articles WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,[after,limit+1])).rows,limit,scope);});}
 detail(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{const row=(await tx.query(`SELECT ${article},review_reference AS "reviewReference",created_by_staff AS "createdByStaff" FROM ops.help_articles WHERE id=$1`,[id])).rows[0];if(!row)throw new ApiError(404,'not-found','Help article is unavailable.');await this.audit(tx,staff,'help.read',id);return row;});}
 create(staff:StaffPrincipal,input:z.infer<typeof articleInput>){return transaction(this.db,async tx=>{let row;try{row=(await tx.query(`INSERT INTO ops.help_articles(locale,slug,version,title,body,review_reference,created_by_staff) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,locale,slug,version,title,state,created_at AS "createdAt"`,[input.locale,input.slug,input.version,input.title,input.body,input.reviewReference,staff.id])).rows[0];}catch(error){if((error as {code?:string}).code==='23505')throw new ApiError(409,'help-version-exists','This article version already exists.');throw error;}await this.audit(tx,staff,'help.create',row.id);return row;});}
 publish(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock($1)',[70419003]);
  const row=(await tx.query('SELECT id,locale,slug,state,review_reference FROM ops.help_articles WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new ApiError(404,'not-found','Help article is unavailable.');
  if(row.state==='published'){await this.audit(tx,staff,'help.publish.retry',id);return {id,state:'published'};}
  if(row.state!=='draft')throw new ApiError(409,'help-state-conflict','Retired articles cannot be published again.');
  if(!row.review_reference)throw new ApiError(409,'review-required','A review reference is required.');
  await tx.query("UPDATE ops.help_articles SET state='retired',retired_at=now() WHERE locale=$1 AND slug=$2 AND state='published'",[row.locale,row.slug]);
  await tx.query("UPDATE ops.help_articles SET state='published',published_at=now() WHERE id=$1",[id]);await this.audit(tx,staff,'help.publish',id);return {id,state:'published'};
 });}
 retire(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{
  const row=(await tx.query('SELECT state FROM ops.help_articles WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new ApiError(404,'not-found','Help article is unavailable.');if(row.state==='retired'){await this.audit(tx,staff,'help.retire.retry',id);return {id,state:'retired'};}
  if(row.state!=='published')throw new ApiError(409,'help-state-conflict','Publish before retiring an article.');
  await tx.query("UPDATE ops.help_articles SET state='retired',retired_at=now() WHERE id=$1",[id]);await this.audit(tx,staff,'help.retire',id);return {id,state:'retired'};
 });}
}
