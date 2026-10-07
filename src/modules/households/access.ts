import type { PoolClient } from 'pg';
import { ApiError } from '../../middleware/error.js';
export type HouseholdRole = 'owner'|'co_guardian'|'walker'|'view_only';

// All membership and dog mutations take the household lock BEFORE checking permission.
// Checking membership in the same statement as a waiting lock can read stale membership.
export async function householdRole(tx: PoolClient, householdId: string, userId: string): Promise<HouseholdRole|undefined> {
  await tx.query('SELECT id FROM identity.households WHERE id=$1 FOR UPDATE',[householdId]);
  return (await tx.query<{role: HouseholdRole}>(`SELECT m.role FROM identity.household_members m
    JOIN identity.households h ON h.id=m.household_id
    WHERE h.id=$1 AND m.user_id=$2 AND m.accepted_at IS NOT NULL AND h.deleted_at IS NULL`,[householdId,userId])).rows[0]?.role;
}
export async function requireHousehold(tx: PoolClient, householdId: string, userId: string, roles?: HouseholdRole[]) {
  const role=await householdRole(tx,householdId,userId);
  if (!role) throw new ApiError(404,'not-found','Household not found.');
  if (roles && !roles.includes(role)) throw new ApiError(403,'forbidden','Your household role cannot perform this action.');
  return role;
}
