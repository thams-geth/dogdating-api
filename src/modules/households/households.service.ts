import { createHash,randomBytes,randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { decodeCursor,page } from '../../http/pagination.js';
import { requireHousehold,type HouseholdRole } from './access.js';
import { HouseholdsRepository } from './households.repository.js';
import type { inviteSchema } from './households.schemas.js';

export class HouseholdsService {
  private readonly repo=new HouseholdsRepository();
  constructor(private readonly db:Pool,private readonly phoneIndex:(phone:string)=>string) {}
  async create(userId:string,name:string) {
    return transaction(this.db,async tx=>{
      await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);
      const count=(await tx.query(`SELECT count(*)::int AS n FROM identity.household_members m
        JOIN identity.households h ON h.id=m.household_id WHERE m.user_id=$1 AND m.accepted_at IS NOT NULL AND h.deleted_at IS NULL`,[userId])).rows[0]!.n;
      if(count>=10)throw new ApiError(409,'household-limit','At most ten households per account are supported.');
      const id=randomUUID();
      await tx.query('INSERT INTO identity.households(id,name,geo_salt) VALUES ($1,$2,$3)',[id,name,randomBytes(32)]);
      await tx.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES ($1,$2,'owner',now())",[id,userId]);
      await this.repo.audit(tx,userId,'household.created',id);
      return this.repo.detail(tx,id,userId);
    });
  }
  async list(userId:string,limit:number,cursor?:string) {
    const scope=`households:${userId}`,after=decodeCursor(cursor,scope);
    const rows=(await this.db.query(`SELECT h.id,h.name,m.role,h.created_at AS "createdAt",h.updated_at AS "updatedAt"
      FROM identity.households h JOIN identity.household_members m ON m.household_id=h.id
      WHERE m.user_id=$1 AND m.accepted_at IS NOT NULL AND h.deleted_at IS NULL AND ($2::uuid IS NULL OR h.id>$2)
      ORDER BY h.id LIMIT $3`,[userId,after,limit+1])).rows;
    const result=page(rows as ({id:string}&Record<string,unknown>)[],limit,scope);return {households:result.items,nextCursor:result.nextCursor};
  }
  detail(userId:string,id:string) {return transaction(this.db,async tx=>{await requireHousehold(tx,id,userId);return this.repo.detail(tx,id,userId);});}
  rename(userId:string,id:string,name:string) {return transaction(this.db,async tx=>{
    await requireHousehold(tx,id,userId,['owner','co_guardian']);await tx.query('UPDATE identity.households SET name=$2,updated_at=now() WHERE id=$1',[id,name]);return this.repo.detail(tx,id,userId);
  });}
  members(userId:string,id:string) {return transaction(this.db,async tx=>{
    await requireHousehold(tx,id,userId);return {members:(await tx.query(`SELECT m.user_id AS "userId",u.display_name AS "displayName",m.role,m.accepted_at AS "acceptedAt"
      FROM identity.household_members m JOIN identity.users u ON u.id=m.user_id
      WHERE m.household_id=$1 AND m.accepted_at IS NOT NULL ORDER BY m.user_id`,[id])).rows};
  });}
  changeMember(userId:string,id:string,targetId:string,role:HouseholdRole|null) {return transaction(this.db,async tx=>{
    await requireHousehold(tx,id,userId,['owner']);
    const target=(await tx.query('SELECT role FROM identity.household_members WHERE household_id=$1 AND user_id=$2 AND accepted_at IS NOT NULL',[id,targetId])).rows[0];
    if(!target)throw new ApiError(404,'not-found','Member not found.');
    if(target.role==='owner' && role!=='owner'){
      const count=(await tx.query("SELECT count(*)::int AS n FROM identity.household_members WHERE household_id=$1 AND role='owner' AND accepted_at IS NOT NULL",[id])).rows[0]!.n;
      if(count<=1)throw new ApiError(409,'last-owner','A household must keep at least one accepted owner.');
    }
    if(role)await tx.query('UPDATE identity.household_members SET role=$3 WHERE household_id=$1 AND user_id=$2',[id,targetId,role]);
    else await tx.query('DELETE FROM identity.household_members WHERE household_id=$1 AND user_id=$2',[id,targetId]);
    await this.repo.audit(tx,userId,role?'household.member_role_changed':'household.member_removed',id);
    // Active-dog pointers are deliberately re-authorized when read; do not retain access on removal.
  });}
  invite(userId:string,id:string,input:z.infer<typeof inviteSchema>) {return transaction(this.db,async tx=>{
    await requireHousehold(tx,id,userId,['owner']);
    const count=(await tx.query("SELECT count(*)::int AS n FROM identity.household_invitations WHERE household_id=$1 AND created_at>now()-interval '1 day'",[id])).rows[0]!.n;
    if(count>=20)throw new ApiError(429,'invite-limit','The daily invitation limit has been reached.');
    const token=randomBytes(32).toString('base64url'),invitationId=randomUUID();
    const row=(await tx.query(`INSERT INTO identity.household_invitations(id,household_id,invited_by,phone_blind_index,role,token_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,now()+interval '7 days') RETURNING expires_at AS "expiresAt"`,[invitationId,id,userId,this.phoneIndex(input.phoneE164),input.role,createHash('sha256').update(token).digest('hex')])).rows[0]!;
    await this.repo.audit(tx,userId,'household.invited',id);
    return {invitationId,inviteToken:token,expiresAt:row.expiresAt,delivery:'manual-share'};
  });}
  accept(userId:string,token:string) {return transaction(this.db,async tx=>{
    // User then household matches onboarding's lock order.
    const user=(await tx.query('SELECT phone_blind_index FROM identity.users WHERE id=$1 FOR UPDATE',[userId])).rows[0]!;
    const tokenHash=createHash('sha256').update(token).digest('hex');
    const initial=(await tx.query('SELECT household_id FROM identity.household_invitations WHERE token_hash=$1',[tokenHash])).rows[0];
    if(!initial)throw new ApiError(404,'not-found','Invitation not found.');
    await tx.query('SELECT id FROM identity.households WHERE id=$1 FOR UPDATE',[initial.household_id]);
    const invitation=(await tx.query(`SELECT i.* FROM identity.household_invitations i JOIN identity.households h ON h.id=i.household_id
      WHERE i.token_hash=$1 AND i.phone_blind_index=$2 AND h.deleted_at IS NULL`,[tokenHash,user.phone_blind_index])).rows[0];
    if(!invitation)throw new ApiError(404,'not-found','Invitation not found.');
    if(invitation.consumed_at || invitation.expires_at<=new Date())throw new ApiError(409,'invitation-unavailable','Invitation has expired or was already used.');
    // Removing or demoting the inviter invalidates outstanding invitations.
    await requireHousehold(tx,invitation.household_id,invitation.invited_by,['owner']);
    const existing=await tx.query('SELECT 1 FROM identity.household_members WHERE household_id=$1 AND user_id=$2',[invitation.household_id,userId]);
    if(existing.rowCount)throw new ApiError(409,'already-member','You are already a household member.');
    const count=(await tx.query('SELECT count(*)::int AS n FROM identity.household_members WHERE user_id=$1 AND accepted_at IS NOT NULL',[userId])).rows[0]!.n;
    if(count>=10)throw new ApiError(409,'household-limit','At most ten households per account are supported.');
    await tx.query('INSERT INTO identity.household_members(household_id,user_id,role,invited_by,accepted_at) VALUES ($1,$2,$3,$4,now())',[invitation.household_id,userId,invitation.role,invitation.invited_by]);
    await tx.query('UPDATE identity.household_invitations SET consumed_at=now(),accepted_by=$2 WHERE id=$1',[invitation.id,userId]);
    await this.repo.audit(tx,userId,'household.invitation_accepted',invitation.household_id);
    return this.repo.detail(tx,invitation.household_id,userId);
  });}
}
